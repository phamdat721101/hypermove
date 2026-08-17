/**
 * src/lib/mcp/gateway.ts
 * ----------------------
 * The middleware pipeline for a single tools/call: metering (free tier →
 * paywall) → tool dispatch → ledger. Keeps the HTTP route thin (transport only).
 *
 * Order: admin bypass → active paid session → free tier → payment settlement →
 * 402 challenge. Everything is a no-op unless its sub-flag is on.
 */

import { createHash } from 'node:crypto';
import { withClient } from '../db';
import { isMcpPaywallEnabled, isMcpRateLimitEnabled, isMcpGuardiansEnabled, isMcpDreamPaymentBindingEnabled } from '../platform-flag';
import { getTool, getTools } from './tools';
import { checkAndConsume, FREE_TIER_LIMIT } from './rate-limit';
import { buildChallenge, findActiveSession, consumeSession, settlePayment, issuePaymentQuote } from './paywall';
import { configuredXrplChain } from './npayment-rails';
import { createSentinel, type Sentinel } from '../sentinel/sentinel';
import { verifyOrHeal } from '../harness/output-enforcer';
import type { McpSession } from './auth';

export interface RpcOutcome {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Gateway Guardians — module-level sentinel singleton ──────────────────
//
// forceEnabled:true makes isMcpGuardiansEnabled() the SOLE gate for this
// instance's check()/record() — independent of FEATURE_HM_PLATFORM (see
// platform-flag.ts's isMcpGuardiansEnabled() doc comment). Lazy singleton,
// mirroring tools.ts's vectorIndex pattern.
let mcpSentinel: Sentinel | null = null;

function getMcpSentinel(): Sentinel {
  if (!mcpSentinel) mcpSentinel = createSentinel({ forceEnabled: true });
  return mcpSentinel;
}

/** Test hook — matches _resetTools()/_resetCatalog()'s naming convention. */
export function _resetMcpSentinel(): void {
  mcpSentinel = null;
}

export function listTools() {
  return getTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, 'x-price-tier': t.tier }));
}

export async function callTool(input: {
  session: McpSession;
  name: string;
  args: Record<string, unknown>;
  headers?: Headers;
}): Promise<RpcOutcome> {
  const { session, name, args, headers } = input;
  const tool = getTool(name);
  if (!tool) return { error: { code: -32601, message: `unknown tool: ${name}` } };

  const started = Date.now();
  let sessionId: string | undefined;

  // ── Gateway Guardians (sentinel pre-call check) ───────────────────────────
  // Independent of metering — a blocked call never reaches the paywall logic.
  // Admin sessions bypass this the same way they bypass metering below.
  const guardiansOn = isMcpGuardiansEnabled() && session.kind !== 'admin';
  if (guardiansOn) {
    const decision = await getMcpSentinel().check({ endpoint: name, agent_id: session.userId, payload: args });
    if (!decision.allow) {
      return { error: { code: -32000, message: 'blocked by guardian policy', data: { policy: decision.policy, reason: decision.reason } } };
    }
  }

  // ── Metering (skipped for admin + unmetered tools like payments.settle) ──
  if (!tool.unmetered && session.kind !== 'admin' && (session.tier === 'free' || tool.requiresPayment)) {
    if (isMcpPaywallEnabled()) {
      const agentId = name === 'start_dream' ? String(args.agent_id ?? '') : undefined;
      const active = await findActiveSession(session.userId, tool.tier, agentId);
      const usedActive = active ? await consumeSession(active.sessionId) : false;
      if (usedActive && active) {
        sessionId = active.sessionId;
      } else {
        if (tool.requiresPayment) {
          const isDreamBinding = name === 'start_dream' && isMcpDreamPaymentBindingEnabled();
          const proof = headers?.get('x-payment');
          // A caller who already presents proof must get a real settlement
          // attempt before the dream-payment-binding branch can short-circuit
          // straight to a fresh quote challenge — otherwise a genuinely valid,
          // already-settled payment can never be accepted (see
          // docs/feedback/2026-08-17-start-dream-payment-proof-never-checked.md).
          if (proof) {
            const settled = await settlePayment(session.userId, tool.tier, headers!, proof);
            if (settled.ok) {
              sessionId = settled.session?.sessionId;
            } else if (isDreamBinding) {
              const quote = await issuePaymentQuote(session.userId, { tier: tool.tier, chain: configuredXrplChain(), asset: 'RLUSD', agentId: agentId ?? '' });
              return { error: { code: -32402, message: 'payment_required', data: quote.ok ? { code: 'payment_required', payment: quote.quote, error: settled.error, hint: settled.hint, ...buildChallenge(tool.tier, 0) } : { code: 'payment_required', error: quote.error, hint: quote.hint, ...buildChallenge(tool.tier, 0) } } };
            } else {
              return { error: { code: -32402, message: settled.error ?? 'payment failed', data: { hint: settled.hint } } };
            }
          } else if (isDreamBinding) {
            const quote = await issuePaymentQuote(session.userId, { tier: tool.tier, chain: configuredXrplChain(), asset: 'RLUSD', agentId: agentId ?? '' });
            return { error: { code: -32402, message: 'payment_required', data: quote.ok ? { code: 'payment_required', payment: quote.quote, ...buildChallenge(tool.tier, 0) } : { code: 'payment_required', error: quote.error, hint: quote.hint, ...buildChallenge(tool.tier, 0) } } };
          } else {
            return { error: { code: -32402, message: `Payment required — settle the ${tool.tier} tier before starting a Dream Cycle.`, data: buildChallenge(tool.tier, 0) } };
          }
        } else {
          const rate = isMcpRateLimitEnabled() ? await checkAndConsume(session.userId) : { allowed: true, resetInHours: 0 };
          if (!rate.allowed) {
            const proof = headers?.get('x-payment');
          if (!proof) {
            if (name === 'start_dream' && agentId) {
              const quote = await issuePaymentQuote(session.userId, { tier: 'dream', chain: configuredXrplChain(), asset: 'RLUSD', agentId });
              return { error: { code: -32402, message: 'payment_required', data: quote.ok ? { code: 'payment_required', payment: quote.quote } : { code: 'payment_required', error: quote.error, hint: quote.hint } } };
            }
            return { error: { code: -32402, message: `Payment required — free tier exceeded (${FREE_TIER_LIMIT} / 24h). Call payments.settle to unlock the ${tool.tier} tier.`, data: buildChallenge(tool.tier, rate.resetInHours) } };
            }
            const settled = await settlePayment(session.userId, tool.tier, headers!, proof);
            if (!settled.ok) return { error: { code: -32402, message: settled.error ?? 'payment failed', data: { hint: settled.hint } } };
            sessionId = settled.session?.sessionId;
          }
        }
      }
    } else if (isMcpRateLimitEnabled()) {
      const rate = await checkAndConsume(session.userId);
      if (!rate.allowed) {
        return { error: { code: -32402, message: `Rate limit exceeded (${FREE_TIER_LIMIT} / 24h)`, data: { retry_after_free_hours: rate.resetInHours } } };
      }
    }
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────
  try {
    const result = await tool.handler(args, { session, ...(sessionId ? { paymentSessionId: sessionId } : {}) });

    // ── Output-enforcer (opt-in via ToolDef.verify) ─────────────────────────
    // No reExecute wired yet — a tool declaring onFail:'self-heal' without a
    // reExecute path degrades to output-enforcer's own "not verified" return
    // (heals stays 0, verified stays false) exactly as block would. Self-heal
    // re-invocation is a deliberate fast-follow, not built this round.
    if (tool.verify) {
      const enforced = await verifyOrHeal(result as Record<string, unknown>, tool.verify);
      if (!enforced.verified) {
        if (guardiansOn) await getMcpSentinel().record({ endpoint: name, agent_id: session.userId, success: false });
        await recordCall({ session, tool: name, tier: tool.tier, args, result: null, sessionId, started, outcome: 'error' });
        return { error: { code: -32000, message: 'output failed verification', data: { checks: enforced.checks } } };
      }
    }

    // ── Dream Cycle cost threading (Task 6, 2026-08-01) ─────────────────────
    // start_dream's result carries an internal-only `_cost` field (see
    // dream/pipeline.ts's StartDreamResult) — the ledger read below is the
    // ONLY consumer of it; it never reaches the MCP client's response.
    const internalCost = (result as { _cost?: { tokensUsed: number; costUsd: number } } | null)?._cost;
    const clientResult = internalCost && result && typeof result === 'object'
      ? Object.fromEntries(Object.entries(result as Record<string, unknown>).filter(([k]) => k !== '_cost'))
      : result;

    if (guardiansOn) await getMcpSentinel().record({ endpoint: name, agent_id: session.userId, success: true });
    await recordCall({
      session, tool: name, tier: tool.tier, args, result: clientResult, sessionId, started, outcome: 'ok',
      tokensUsed: internalCost?.tokensUsed, costUsd: internalCost?.costUsd,
    });
    return { result: clientResult };
  } catch (err) {
    if (guardiansOn) await getMcpSentinel().record({ endpoint: name, agent_id: session.userId, success: false });
    await recordCall({ session, tool: name, tier: tool.tier, args, result: null, sessionId, started, outcome: 'error' });
    return { error: { code: -32000, message: err instanceof Error ? err.message : String(err) } };
  }
}

function safeByteLen(v: unknown): number {
  if (v == null) return 0;
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}

async function recordCall(c: {
  session: McpSession; tool: string; tier: string; args: unknown; result: unknown;
  sessionId?: string; started: number; outcome: 'ok' | 'error' | 'soft_empty';
  /**
   * Real token/cost figures for the one call-path with genuine non-zero
   * marginal LLM cost today (Dream Cycle's extraction stage — see
   * dream/pipeline.ts). Every other call site omits these, inserting NULL —
   * intentional (deterministic reads/corpus lookups have zero LLM cost),
   * not a gap to backfill.
   */
  tokensUsed?: number;
  costUsd?: number;
}): Promise<void> {
  const bytes = safeByteLen(c.result);
  // Confidential-tool args (attestation quotes) are never persisted in plaintext
  // via the standard ledger path — redacted to key names only (success criterion 5).
  //
  // Dream Cycle Confidential Extraction on Flare FCC, Task 6: start_dream is
  // deliberately NOT added to this prefix list. Checked, not assumed: its MCP
  // args are {agent_id, config:{budget_usd, preset, confidential, trigger_criteria}}
  // — no attestation quote or other TEE secret ever flows through a client-
  // supplied tool argument for this feature (the quote lives entirely inside
  // extractOneClusterConfidential()'s internal dispatch/verify call chain, see
  // dream/extract.ts's Task 4/5). Redacting start_dream's args here would only
  // hide non-sensitive budget/preset values with no real confidentiality gain.
  const CONFIDENTIAL_TOOL_PREFIX = ['confidential.', 'flare.confidential.'];
  const argsForLog = CONFIDENTIAL_TOOL_PREFIX.some((p) => c.tool.startsWith(p))
    ? { redacted: true, argKeys: Object.keys((c.args as Record<string, unknown>) ?? {}) }
    : c.args;
  const paramsHash = createHash('sha256').update(JSON.stringify(argsForLog ?? '')).digest('hex').slice(0, 32);
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO mcp_calls (user_id, session_id, tool_name, tier, params_hash, response_bytes, latency_ms, outcome, tokens_used, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [c.session.userId, c.sessionId ?? null, c.tool, c.tier, paramsHash, bytes, Date.now() - c.started, c.outcome, c.tokensUsed ?? null, c.costUsd ?? null],
    );
    return true;
  });
}
