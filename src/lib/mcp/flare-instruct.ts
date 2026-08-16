/**
 * src/lib/mcp/flare-instruct.ts
 * ------------------------------
 * The MCP bridge to HyperMove's own Flare Compute Extension (services/tee-extension/,
 * see biz-team/bd-team/research/hypermove/2026-07-20-tee-proxy-fcc-extension-token-profile/).
 *
 * Submits an instruction to the deployed InstructionSender contract, then polls
 * ext-proxy's public result endpoint. Honest by construction:
 *  - Feature flag off              → structured `feature_disabled` fail.
 *  - No TEE-extension service      → `not_configured` (THIS IS THE EXPECTED DEFAULT
 *    configured (env vars unset)     STATE until services/tee-extension is deployed to
 *                                     Coston2 — see its README's real credential/tunnel
 *                                     blockers — never a fabricated result).
 *  - Service reachable              → real HTTP call + on-chain submission, whatever
 *                                     comes back (including the extension's own honest
 *                                     "not yet implemented" refusal for FINANCIAL_ACTION/
 *                                     GENERIC_AGENT_TASK) is passed through verbatim.
 *
 * Mirrors confidential.ts's structure (flag check → configured check → runHarnessed()
 * wrapping the real network call → map to ServiceResult) so this module and that one
 * stay recognizably the same shape for anyone reading both.
 *
 * instructionId (fixed 2026-08-08): HyperMoveInstructionSender.sol's
 * sendFinancialAction/sendGenericAgentTask now `return` the registry's real
 * instructionId (previously discarded — this module fell back to using the
 * submission tx hash as a stand-in polling key, which is NOT what ext-proxy's
 * public API actually keys results by). Decoded via viem's
 * simulateContract()+writeContract(request) pattern below. No Go-side ABI
 * export or event log was ever required for this — see services/tee-extension's
 * contracts/InstructionSender.sol for the contract-side fix.
 */

import { createWalletClient, createPublicClient, http, encodeAbiParameters, defineChain, type Address } from 'viem';
import { ok, fail, type ServiceResult } from './envelope';
import { isMcpInstructEnabled } from '../platform-flag';
import { FLARE_RPC, FLARE_CHAIN_IDS } from './providers/chain-constants';
import { runHarnessed, type SkillDef } from 'nim-skill';
import { mcpNimHarness } from './nim-harness';

export type InstructOpType = 'FINANCIAL_ACTION' | 'GENERIC_AGENT_TASK';
export type FinancialActionCommand = 'SWAP' | 'SETTLE';

export interface InstructDispatchInput {
  opType: InstructOpType;
  /** Required when opType is FINANCIAL_ACTION; ignored otherwise (GENERIC_AGENT_TASK
   *  always uses the extension's single COMPUTE command). */
  opCommand?: FinancialActionCommand;
  message: Record<string, unknown>;
  /** Default 'coston2' — the only network this ships against (see the PRD's non-goals). */
  network?: string;
  pollTimeoutMs?: number;
}

export interface InstructDispatchResult {
  instructionId: string;
  txHash: string;
  status: 'success' | 'pending' | 'error';
  /** Reserved for once PMW settlement execution ships (see services/tee-extension's
   *  honest-stub boundary) — always null in this ship. Never fabricated. */
  settlementTxHash: string | null;
  data: unknown;
  log?: string;
}

interface DispatchExecuteResult extends Partial<InstructDispatchResult> {
  instructionId: string;
  status: 'success' | 'pending' | 'error';
  [key: string]: unknown;
}

const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;
const INSTRUCTION_FEE_WEI = 1_000_000n; // must match the deployed registry's required fee

/** ABI fragment for the two send functions — kept minimal, matching only what this
 *  module calls. Full ABI lives in services/tee-extension's generated bindings. */
const INSTRUCTION_SENDER_ABI = [
  {
    type: 'function',
    name: 'sendFinancialAction',
    stateMutability: 'payable',
    inputs: [
      { name: '_opCommand', type: 'bytes32' },
      { name: '_message', type: 'bytes' },
    ],
    outputs: [{ name: '_instructionId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'sendGenericAgentTask',
    stateMutability: 'payable',
    inputs: [{ name: '_message', type: 'bytes' }],
    outputs: [{ name: '_instructionId', type: 'bytes32' }],
  },
] as const;
// NOTE: this ABI's `outputs` describes the FIXED HyperMoveInstructionSender.sol
// contract (see Task 1 fix, 2026-08-08) — the send* wrapper functions now
// explicitly `return` the registry's instructionId themselves (previously they
// discarded it; ITeeExtensionRegistry.sendInstructions() always returned it,
// but the wrapper never propagated it). See contracts/InstructionSender.sol.

function opCommandToBytes32(command: string): `0x${string}` {
  const bytes = new TextEncoder().encode(command);
  const padded = new Uint8Array(32);
  padded.set(bytes.slice(0, 32));
  return `0x${Buffer.from(padded).toString('hex')}` as `0x${string}`;
}

function encodeFinancialActionMessage(message: Record<string, unknown>): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'action', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'chain', type: 'string' }] }],
    [{ action: String(message.action ?? ''), amount: String(message.amount ?? ''), chain: String(message.chain ?? '') }],
  );
}

function encodeGenericAgentTaskMessage(message: Record<string, unknown>): `0x${string}` {
  const payload = message.payload;
  const payloadHex = typeof payload === 'string' ? (payload.startsWith('0x') ? payload : `0x${Buffer.from(payload).toString('hex')}`) : '0x';
  return encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'taskType', type: 'string' }, { name: 'payload', type: 'bytes' }] }],
    [{ taskType: String(message.taskType ?? ''), payload: payloadHex as `0x${string}` }],
  );
}

interface ExtProxyActionResult {
  status: number; // 0=error, 1=success, >=2=pending
  log?: string;
  data?: string; // hexutil.Bytes-encoded (0x-prefixed hex) — decode before use
}

async function pollExtProxy(proxyUrl: string, instructionId: string, timeoutMs: number): Promise<ExtProxyActionResult> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: ExtProxyActionResult = { status: 2 };

  while (Date.now() < deadline) {
    // Fixed (2026-08-08, real Coston2 deployment): the real ext-proxy route is
    // GET /action/result/{actionID} (see tee-proxy's internal/server/external.go),
    // not /action-result/{id} — found by reading the actual route table against a
    // live deployment rather than assuming the URL shape, per this project's own
    // "verify one layer deeper" discipline (see .kiro/steering/lessons-learned.md).
    const res = await fetch(`${proxyUrl.replace(/\/$/, '')}/action/result/${instructionId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = (await res.json()) as { result?: ExtProxyActionResult };
      if (body.result) {
        lastResult = body.result;
        if (lastResult.status !== 2) return lastResult;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return lastResult; // still pending at timeout — returned as-is, never upgraded to success
}

/** viem's built-in chains list has no Coston2/Songbird entry — defineChain() a
 *  minimal viem Chain from the same pinned constants chain-constants.ts already
 *  exports, so createWalletClient/createPublicClient satisfy viem's required
 *  `chain` param without duplicating network metadata (WR-04). */
function resolveFlareChain(network: string, rpc: string) {
  const id = FLARE_CHAIN_IDS[network] ?? FLARE_CHAIN_IDS.coston2;
  return defineChain({
    id,
    name: network,
    nativeCurrency: { name: 'Flare', symbol: network === 'songbird' ? 'SGB' : 'FLR', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

async function submitAndPoll(
  input: InstructDispatchInput,
  proxyUrl: string,
  instructionSenderAddr: Address,
): Promise<DispatchExecuteResult> {
  const network = input.network ?? 'coston2';
  const rpc = FLARE_RPC[network] ?? FLARE_RPC.coston2;
  const privateKey = process.env.FLARE_INSTRUCT_SIGNER_KEY;
  if (!privateKey) {
    return { instructionId: 'unknown', status: 'error', log: 'FLARE_INSTRUCT_SIGNER_KEY not configured' };
  }

  const chain = resolveFlareChain(network, rpc);
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) });

  let txHash: `0x${string}`;
  let instructionId: `0x${string}`;
  if (input.opType === 'FINANCIAL_ACTION') {
    const opCommand = opCommandToBytes32(input.opCommand ?? 'SWAP');
    const message = encodeFinancialActionMessage(input.message);
    // Fixed (2026-08-08): ITeeExtensionRegistry.sendInstructions() returns the
    // real `bytes32 _instructionId` directly (see
    // services/tee-extension/extension-examples/extension-scaffold/contracts/
    // interfaces/ITeeExtensionRegistry.sol) — sendFinancialAction/
    // sendGenericAgentTask on HyperMoveInstructionSender.sol simply forward
    // that return value, they don't re-declare it, so simulateContract()
    // against InstructionSender's own ABI can't decode it either. Simulate
    // against the underlying registry call instead to decode the real id
    // BEFORE submitting, then submit via writeContract as before. This
    // replaces the previous tx-hash substitution (no Go-side ABI export or
    // event log needed — the value was always available as a return value).
    const sim = await publicClient.simulateContract({
      account,
      address: instructionSenderAddr,
      abi: INSTRUCTION_SENDER_ABI,
      functionName: 'sendFinancialAction',
      args: [opCommand, message],
      value: INSTRUCTION_FEE_WEI,
    });
    instructionId = (sim.result as unknown as `0x${string}`) ?? '0x0';
    txHash = await walletClient.writeContract(sim.request);
  } else {
    const message = encodeGenericAgentTaskMessage(input.message);
    const sim = await publicClient.simulateContract({
      account,
      address: instructionSenderAddr,
      abi: INSTRUCTION_SENDER_ABI,
      functionName: 'sendGenericAgentTask',
      args: [message],
      value: INSTRUCTION_FEE_WEI,
    });
    instructionId = (sim.result as unknown as `0x${string}`) ?? '0x0';
    txHash = await walletClient.writeContract(sim.request);
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  // instructionId now comes from the real, decoded sendInstructions() return
  // value (see above) — no longer a tx-hash substitution. ext-proxy's public
  // API keys results by this real instruction ID.

  const result = await pollExtProxy(proxyUrl, instructionId, input.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);

  return {
    instructionId,
    txHash: receipt.transactionHash,
    status: result.status === 1 ? 'success' : result.status === 0 ? 'error' : 'pending',
    settlementTxHash: null,
    data: decodeActionResultData(result.data),
    log: result.log,
  };
}

/**
 * ext-proxy's /action/result response encodes ActionResult.Data as
 * hexutil.Bytes (0x-prefixed hex of raw bytes) — the extension's Go handlers
 * (internal/extension/extension.go) json.Marshal their response struct into
 * those bytes, so this must hex-decode THEN JSON-parse, not just JSON.parse
 * the hex string directly. Fails honestly to null on any malformed input —
 * never a fabricated result.
 */
function decodeActionResultData(hex: string | undefined): unknown {
  if (!hex) return null;
  try {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (clean.length === 0) return null;
    const bytes = Buffer.from(clean, 'hex');
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Submit an instruction to HyperMove's InstructionSender contract on Coston2, then
 * poll ext-proxy's public result endpoint. See the module doc comment for the honest
 * behavior at each stage.
 */
export async function dispatchInstruction(input: InstructDispatchInput): Promise<ServiceResult<InstructDispatchResult>> {
  if (!isMcpInstructEnabled()) {
    return fail('flare-instruct', 'instruction dispatch disabled', { code: 'feature_disabled', hint: 'set FEATURE_MCP_INSTRUCT_V1=true' });
  }

  const extProxyUrl = process.env.TEE_EXTENSION_PROXY_URL;
  const instructionSenderAddr = process.env.FLARE_INSTRUCTION_SENDER_ADDRESS as Address | undefined;
  if (!extProxyUrl || !instructionSenderAddr) {
    return fail('flare-instruct', 'TEE-extension service not configured', {
      code: 'not_configured',
      hint: 'set TEE_EXTENSION_PROXY_URL and FLARE_INSTRUCTION_SENDER_ADDRESS once services/tee-extension is deployed to Coston2 (see its README)',
    });
  }

  const skill: SkillDef<Record<string, unknown>, DispatchExecuteResult> = {
    name: 'flare.instruct.dispatch',
    version: '1.0.0',
    harness: mcpNimHarness({
      enforcer: {
        strategies: [{ kind: 'schema', required: ['instructionId', 'status'] }],
        maxHeals: 0, // a submit-and-poll result is never "healed" — either the chain/proxy answered or it didn't
        mode: 'strict',
      },
    }),
    async execute(execInput, ctx) {
      try {
        return await submitAndPoll(execInput as unknown as InstructDispatchInput, extProxyUrl, instructionSenderAddr);
      } catch (err) {
        const log = err instanceof Error ? err.message : String(err);
        return { instructionId: 'unknown', status: 'error' as const, log: ctx.logCompact?.compact(log).text ?? log };
      }
    },
  };

  const { output, verified } = await runHarnessed(skill, input as unknown as Record<string, unknown>, { agentId: 'hypermove-flare-instruct' });
  if (!verified) {
    return fail('flare-instruct', 'dispatch result failed schema verification', { code: 'enforcer_block' });
  }
  if (output.status === 'error') {
    return fail('flare-instruct', output.log ?? 'instruction dispatch failed', { code: 'dispatch_failed' });
  }
  return ok({
    instructionId: output.instructionId,
    txHash: output.txHash ?? output.instructionId,
    status: output.status,
    settlementTxHash: output.settlementTxHash ?? null,
    data: output.data ?? null,
    log: output.log,
  });
}
