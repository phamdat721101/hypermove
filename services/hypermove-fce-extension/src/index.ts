/**
 * src/index.ts
 * -------------
 * The Hono app: POST /action on port 8889 (matching Flare's real
 * ExtensionPort default — internal/settings/settings.go). Receives a real
 * wire-format Action from the TEE node's ForwardRouter (see
 * internal/router/routers.go's NewForwardRouter → defInst → PostActionToExtension),
 * decodes it, calls HyperMove's MCP gateway, builds a signed commitment, and
 * returns a wire-format ActionResult.
 *
 * The core per-request logic (decode → route → call HyperMove → commit →
 * sign → encode) is wrapped in nim-skill's runHarnessed(), per this
 * project's build instructions — same pattern as hypermove-app's
 * flare-instruct.ts / confidential.ts: a SkillDef with a schema enforcer,
 * maxHeals: 0 (an action result is never "healed" into validity — either
 * the pipeline produced a real result or it didn't), mode: 'strict'.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { runHarnessed, type SkillDef } from 'nim-skill';
import type { Hex } from 'viem';
import {
  decodeAction,
  encodeActionResult,
  toOpHash,
  unsupportedOpTypeLog,
  unsupportedOpCommandLog,
  type WireAction,
  type WireActionResult,
  type DecodedAction,
  type DecodeError,
} from './action-codec.js';
import { callHyperMoveTool } from './hypermove.client.js';
import { signWithTee, signWithWallet } from './tee.client.js';
import { buildSearchCommitment, chainIdFor, hashContent } from './commitments.js';
import {
  PORTS,
  DEFAULT_NETWORK,
  OP_COMMAND_SWAP,
  OP_COMMAND_SETTLE,
  OP_COMMAND_COMPUTE,
  HYPERMOVE_OP_COMMANDS,
} from './config.js';

const EXTENSION_VERSION = '0.1.0';

/** OPCommand -> HyperMove MCP tool name (F001 action router). */
const OP_COMMAND_TO_TOOL: Record<string, string> = {
  SEARCH: 'search',
  NEWS_SEARCH: 'news.search',
  NEWS_DIGEST: 'news.digest',
  NEWS_INSIGHT: 'news.insight',
  CODEMODE_SPEC: 'codemode.spec',
  CODEMODE_VECTOR_SEARCH: 'codemode.vector_search',
  SKILL_RUN: 'skills.run',
};

export interface RuntimeConfig {
  hyperMoveBaseUrl: string;
  hyperMoveBearerToken: string;
  teeSignBaseUrl: string;
}

/** Validated at startup (Task 10 / F005) — fails fast with a clear message
 *  rather than making unauthenticated calls that silently 401. */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const hyperMoveBearerToken = env.HYPERMOVE_MCP_ADMIN_TOKEN;
  if (!hyperMoveBearerToken) {
    throw new Error(
      'HYPERMOVE_MCP_ADMIN_TOKEN is not set. This extension cannot authenticate to HyperMove\'s ' +
        'MCP gateway without it — see .env.example and README.md "Known tradeoff: admin-token reuse".',
    );
  }
  return {
    hyperMoveBaseUrl: env.HYPERMOVE_MCP_URL ?? 'https://hypermove.duckdns.org/api/mcp',
    hyperMoveBearerToken,
    teeSignBaseUrl: env.TEE_SIGN_URL ?? `http://localhost:${PORTS.sign}`,
  };
}

interface HandleActionOutput {
  result: WireActionResult;
  [key: string]: unknown;
}

/**
 * The core per-action pipeline, wrapped by runHarnessed() in buildApp().
 * Never throws — every failure path resolves to a well-formed
 * HandleActionOutput so the enforcer's schema check (`required: ['result']`)
 * always has something to verify.
 */
async function handleAction(action: WireAction, config: RuntimeConfig): Promise<HandleActionOutput> {
  const decoded = decodeAction(action);

  if (isDecodeError(decoded)) {
    return { result: buildErrorResult(action, decoded) };
  }

  if (decoded.opType === 'FINANCIAL_ACTION') {
    return { result: await handleFinancialAction(decoded) };
  }

  return { result: await handleGenericAgentTask(decoded, config) };
}

function isDecodeError(v: DecodedAction | DecodeError): v is DecodeError {
  return 'kind' in v && v.kind !== undefined && !('opType' in v);
}

function buildErrorResult(action: WireAction, err: DecodeError): WireActionResult {
  const id = action.data.id;
  const submissionTag = action.data.submissionTag ?? 'submit';
  let log: string;
  let opType = toOpHash('');
  let opCommand = toOpHash('');

  if (err.kind === 'bad_data_message') {
    log = `decoding fixed data: ${err.message}`;
  } else if (err.kind === 'unsupported_op_type') {
    log = unsupportedOpTypeLog(err.receivedHash, err.receivedLabel);
    opType = err.receivedHash;
  } else if (err.kind === 'unsupported_op_command') {
    const validCommands =
      err.opTypeLabel === 'FINANCIAL_ACTION' ? [OP_COMMAND_SWAP, OP_COMMAND_SETTLE] : [OP_COMMAND_COMPUTE, ...HYPERMOVE_OP_COMMANDS];
    log = unsupportedOpCommandLog(err.opTypeLabel, err.receivedHash, err.receivedLabel, validCommands);
    opCommand = err.receivedHash;
  } else {
    log = `decoding request: ${err.message}`;
  }

  return encodeActionResult({ id, submissionTag, status: 0, log, opType, opCommand, version: EXTENSION_VERSION, dataPayload: null });
}

/**
 * FINANCIAL_ACTION/SWAP|SETTLE — honest not-yet-implemented stub. Protocol
 * Managed Wallets' third-party signing interface is not published (same
 * blocker named in Sub-PRD A / providers/flare.ts's executeFccConfidential()
 * / extension-scaffold's handleFinancialAction()) — this extension does not
 * guess at a settlement ABI. Mirrors the real Go stub's exact honesty
 * pattern and log wording style.
 */
async function handleFinancialAction(decoded: DecodedAction): Promise<WireActionResult> {
  const f = decoded.financial!;
  const log =
    `financial-action execution not yet implemented — PMW (Protocol Managed Wallets) third-party ` +
    `invocation interface not published as of this ship; see dev.flare.network/fcc/overview for updates. ` +
    `Decoded request: action=${f.action} amount=${f.amount} chain=${f.chain}`;
  return encodeActionResult({
    id: decoded.id,
    submissionTag: decoded.submissionTag,
    status: 0,
    log,
    opType: toOpHash('FINANCIAL_ACTION'),
    opCommand: toOpHash(decoded.opCommand),
    version: EXTENSION_VERSION,
    dataPayload: null,
  });
}

/**
 * GENERIC_AGENT_TASK — routes HyperMove-specific OPCommands to a HyperMove
 * MCP tool call (F001); COMPUTE (Sub-PRD A's original placeholder) stays an
 * honest stub since it was never a HyperMove-routed command.
 */
async function handleGenericAgentTask(decoded: DecodedAction, config: RuntimeConfig): Promise<WireActionResult> {
  const g = decoded.generic!;
  const tool = OP_COMMAND_TO_TOOL[decoded.opCommand];

  if (!tool) {
    // COMPUTE or any other non-HyperMove-routed command under GENERIC_AGENT_TASK.
    return encodeActionResult({
      id: decoded.id,
      submissionTag: decoded.submissionTag,
      status: 0,
      log:
        `generic-agent-task execution not yet implemented for OPCommand ${decoded.opCommand} — ` +
        `this extension only routes HyperMove-specific commands (${HYPERMOVE_OP_COMMANDS.join(', ')}) to a real MCP call. ` +
        `Decoded request: taskType=${g.taskType} payloadBytes=${g.payloadBytes}`,
      opType: toOpHash('GENERIC_AGENT_TASK'),
      opCommand: toOpHash(decoded.opCommand),
      version: EXTENSION_VERSION,
      dataPayload: null,
    });
  }

  const paymentMode = (g.argumentsJson?.payment_mode as string | undefined) ?? 'AGENT_PASSTHROUGH';
  const args = { ...(g.argumentsJson ?? {}) };
  delete (args as Record<string, unknown>).payment_mode;

  const call = await callHyperMoveTool({
    tool,
    arguments: args,
    baseUrl: config.hyperMoveBaseUrl,
    bearerToken: config.hyperMoveBearerToken,
  });

  return buildResultFromHyperMoveCall(decoded, tool, call, paymentMode, config);
}

async function buildResultFromHyperMoveCall(
  decoded: DecodedAction,
  tool: string,
  call: Awaited<ReturnType<typeof callHyperMoveTool>>,
  paymentMode: string,
  config: RuntimeConfig,
): Promise<WireActionResult> {
  const opType = toOpHash('GENERIC_AGENT_TASK');
  const opCommand = toOpHash(decoded.opCommand);
  const base = { id: decoded.id, submissionTag: decoded.submissionTag, opType, opCommand, version: EXTENSION_VERSION };

  if (call.kind === 'network_error') {
    return encodeActionResult({ ...base, status: 0, log: `HyperMove call failed (network): ${call.message}`, dataPayload: null });
  }

  if (call.kind === 'error') {
    return encodeActionResult({ ...base, status: 0, log: `HyperMove tool "${tool}" returned an error: ${call.message}`, dataPayload: null });
  }

  if (call.kind === 'payment_required') {
    return buildPaymentRequiredResult(base, call, paymentMode, decoded, tool, config);
  }

  // call.kind === 'ok' (covers both real success and the soft-empty variant —
  // CRITICAL RULE: soft-empty is success, never an error, per the PRD and
  // envelope.ts's real contract).
  const isSoftEmpty = 'softEmpty' in call && call.softEmpty === true;
  const dataPayload = isSoftEmpty ? { softEmpty: true, message: call.message, data: null } : { data: call.data };

  const commitment = buildCommitmentFor(decoded, tool, call.data, config);
  const signed = await signCommitment(config, commitment.digest);

  return encodeActionResult({
    ...base,
    status: 1,
    log: isSoftEmpty ? `HyperMove tool "${tool}" returned soft-empty: ${call.message}` : `HyperMove tool "${tool}" ok`,
    dataPayload: {
      ...dataPayload,
      commitment: { scheme: commitment.scheme, digest: commitment.digest, timestamp: commitment.timestamp, chainId: commitment.chainId.toString() },
      tee_signature: signed.ok ? signed.result : null,
      tee_signature_error: signed.ok ? undefined : signed.message,
    },
  });
}

function buildCommitmentFor(decoded: DecodedAction, tool: string, data: unknown, config: RuntimeConfig) {
  const timestamp = Math.floor(Date.now() / 1000);
  const chainId = chainIdFor(DEFAULT_NETWORK);
  const g = decoded.generic!;
  if (decoded.opCommand === 'SEARCH') {
    const d = (data ?? {}) as Record<string, unknown>;
    const digest = buildSearchCommitment({
      chainId,
      tool,
      query: String(g.argumentsJson?.query ?? d.query ?? ''),
      total: Number(d.total ?? 0),
      nextCursor: String(d.nextCursor ?? ''),
      timestamp,
    });
    return { scheme: 'HYPERMOVE_SEARCH_V1', digest, timestamp, chainId };
  }
  // Generic fallback for every other HyperMove OPCommand: hash the whole
  // result payload. This is intentionally simple — the PRD only specifies
  // named schemes for SEARCH and NEWS_DIGEST; every other command gets a
  // content-hash commitment rather than a guessed bespoke ABI layout
  // (WR-04: don't invent structure the PRD didn't ask for).
  const digest = hashContent({ scheme: 'HYPERMOVE_GENERIC_V1', tool, data, timestamp });
  void config; // reserved for a future per-network chain-id override, unused today
  return { scheme: 'HYPERMOVE_GENERIC_V1', digest, timestamp, chainId };
}

async function signCommitment(config: RuntimeConfig, digest: string) {
  return signWithTee(config.teeSignBaseUrl, digest);
}

/**
 * F003 — payment handling. AGENT_PASSTHROUGH (default): package the 402
 * challenge into the ActionResult so an on-chain caller/agent can react.
 * TEE_WALLET: honest not-yet-implemented stub via tee.client's
 * signWithWallet() — never fabricates a settlement, same discipline as
 * handleFinancialAction() above.
 */
async function buildPaymentRequiredResult(
  base: { id: Hex; submissionTag: string; opType: Hex; opCommand: Hex; version: string },
  call: { kind: 'payment_required'; challenge: unknown; message: string },
  paymentMode: string,
  decoded: DecodedAction,
  tool: string,
  config: RuntimeConfig,
): Promise<WireActionResult> {
  if (paymentMode === 'TEE_WALLET') {
    // Honest stub: this extension does not guess at PMW's unpublished
    // third-party invocation ABI. A real walletId/keyId and raw settlement
    // tx are not fabricated — signWithWallet() is called with a structural
    // no-op placeholder only to exercise the real client-side validation
    // path; the result is always the same honest refusal regardless.
    const stub = await signWithWallet(config.teeSignBaseUrl, `0x${'0'.repeat(64)}`, 0, '0x00');
    return encodeActionResult({
      ...base,
      status: 0,
      log:
        `payment required for HyperMove tool "${tool}" and payment_mode=TEE_WALLET — settlement via ` +
        `Protocol Managed Wallets is not yet implemented (unpublished third-party invocation interface). ` +
        `challenge=${JSON.stringify(call.challenge)}`,
      dataPayload: { paymentRequired: true, challenge: call.challenge, teeWalletStubAttempted: stub.ok, decodedTool: tool },
    });
  }

  // AGENT_PASSTHROUGH (default) — pass the challenge through verbatim.
  return encodeActionResult({
    ...base,
    status: 0,
    log: `payment required for HyperMove tool "${tool}": ${call.message}`,
    dataPayload: { paymentRequired: true, challenge: call.challenge, decodedTool: tool, opCommand: decoded.opCommand },
  });
}

// ─── Harnessed wrapper + Hono app ───────────────────────────────────────────

function buildHandleActionSkill(config: RuntimeConfig): SkillDef<Record<string, unknown>, HandleActionOutput> {
  return {
    name: 'hypermove-fce.handle-action',
    version: '1.0.0',
    harness: {
      enforcer: {
        strategies: [{ kind: 'schema', required: ['result'] }],
        maxHeals: 0, // an action result is never "healed" — either the pipeline produced one or it didn't
        mode: 'strict',
      },
    },
    async execute(input) {
      return handleAction((input as { action: WireAction }).action, config);
    },
  };
}

export function createApp(config: RuntimeConfig): Hono {
  const app = new Hono();

  app.post('/action', async (c) => {
    let action: WireAction;
    try {
      action = await c.req.json<WireAction>();
    } catch (err) {
      return c.json({ error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

    const skill = buildHandleActionSkill(config);
    const { output, verified } = await runHarnessed(skill, { action } as Record<string, unknown>, { agentId: 'hypermove-fce-extension' });

    if (!verified) {
      // The enforcer's schema check failed — this should be unreachable
      // (handleAction always returns { result }), but fail closed with a
      // structured 500 rather than leaking an unverified/partial output.
      return c.json({ error: 'action handler output failed schema verification' }, 500);
    }

    return c.json(output.result, 200);
  });

  app.get('/healthz', (c) => c.json({ ok: true, version: EXTENSION_VERSION }));

  return app;
}

/* c8 ignore start -- exercised via `npm run dev`, not unit tests */
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfigFromEnv();
  const app = createApp(config);
  const port = Number(process.env.TEE_EXTENSION_PORT ?? PORTS.action);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`hypermove-fce-extension listening on :${info.port} (POST /action)`);
  });
}
/* c8 ignore stop */
