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
import { isMcpPaywallEnabled, isMcpRateLimitEnabled } from '../platform-flag';
import { getTool, getTools } from './tools';
import { checkAndConsume } from './rate-limit';
import { buildChallenge, findActiveSession, consumeSession, settlePayment } from './paywall';
import type { McpSession } from './auth';

export interface RpcOutcome {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
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

  // ── Metering (skipped for admin + unmetered tools like payments.settle) ──
  if (!tool.unmetered && session.kind !== 'admin' && session.tier === 'free') {
    if (isMcpPaywallEnabled()) {
      const active = await findActiveSession(session.userId, tool.tier);
      const usedActive = active ? await consumeSession(active.sessionId) : false;
      if (usedActive && active) {
        sessionId = active.sessionId;
      } else {
        const rate = isMcpRateLimitEnabled() ? await checkAndConsume(session.userId) : { allowed: true, resetInHours: 0 };
        if (!rate.allowed) {
          const proof = headers?.get('x-payment');
          if (!proof) {
            return { error: { code: -32402, message: `Payment required — free tier exceeded (10 / 24h). Call payments.settle to unlock the ${tool.tier} tier.`, data: buildChallenge(tool.tier, rate.resetInHours) } };
          }
          const settled = await settlePayment(session.userId, tool.tier, headers!, proof);
          if (!settled.ok) return { error: { code: -32402, message: settled.error ?? 'payment failed', data: { hint: settled.hint } } };
          sessionId = settled.session?.sessionId;
        }
      }
    } else if (isMcpRateLimitEnabled()) {
      const rate = await checkAndConsume(session.userId);
      if (!rate.allowed) {
        return { error: { code: -32402, message: `Rate limit exceeded (10 / 24h)`, data: { retry_after_free_hours: rate.resetInHours } } };
      }
    }
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────
  try {
    const result = await tool.handler(args, { session });
    await recordCall({ session, tool: name, tier: tool.tier, args, result, sessionId, started, outcome: 'ok' });
    return { result };
  } catch (err) {
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
}): Promise<void> {
  const bytes = safeByteLen(c.result);
  const paramsHash = createHash('sha256').update(JSON.stringify(c.args ?? '')).digest('hex').slice(0, 32);
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO mcp_calls (user_id, session_id, tool_name, tier, params_hash, response_bytes, latency_ms, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [c.session.userId, c.sessionId ?? null, c.tool, c.tier, paramsHash, bytes, Date.now() - c.started, c.outcome],
    );
    return true;
  });
}
