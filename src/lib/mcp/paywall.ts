/**
 * src/lib/mcp/paywall.ts
 * ----------------------
 * Tiered pricing + the x402/MPP challenge + session-bundled billing. Depends on
 * the PaymentRail interface (payment-router) — never on a concrete rail.
 *
 * Session-bundled billing: one on-chain settlement covers up to 100 queries at
 * a tier, so per-query gas overhead stays viable (pre-mortem PT3).
 */

import { withClient } from '../db';
import type { PriceTier } from './catalog';
import {
  parseSelection,
  selectRail,
  supportedNetworks,
  validateSelection,
  type PaymentReceipt,
  type PaymentSelection,
} from './payment-router';

export const TIER_PRICE_USD: Record<PriceTier, string> = {
  t1_read: '0.001',
  t2_realtime: '0.01',
  t3_vector: '0.10',
};

const SESSION_QUOTA = 100;
const SESSION_TTL_MS = 3_600_000; // 1 hour

/** The x402 payment-required challenge (advertises the full selection matrix). */
export function buildChallenge(tier: PriceTier, resetInHours: number) {
  const nets = supportedNetworks();
  return {
    'x-payment-required': {
      chains: nets.map((n) => n.chain),
      assets: Array.from(new Set(nets.flatMap((n) => n.assets))).sort(),
      amount: TIER_PRICE_USD[tier],
      tier,
      amounts: TIER_PRICE_USD,
      facilitators: {
        x402: '/api/paid-endpoint',
        mpp: '/api/paid-endpoint?rail=mpp',
      },
      select_via_headers: ['X-Payment-Chain', 'X-Payment-Rail', 'X-Payment-Asset'],
      retry_after_free_hours: resetInHours,
    },
  };
}

export interface PaidSession {
  sessionId: string;
  tier: PriceTier;
  chain: string;
  quotaRemaining: number;
}

/** Reuse an active paid session for this tier if one exists with quota left. */
export async function findActiveSession(userId: string, tier: PriceTier): Promise<PaidSession | null> {
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{ session_id: string; chain: string; quota_limit: number; quota_used: number }>(
      `SELECT session_id, chain, quota_limit, quota_used FROM mcp_paid_sessions
       WHERE user_id = $1 AND tier = $2 AND expires_at > NOW() AND quota_used < quota_limit
       ORDER BY created_at DESC LIMIT 1`,
      [userId, tier],
    );
    return rows[0] ?? null;
  });
  if (!row) return null;
  return { sessionId: row.session_id, tier, chain: row.chain, quotaRemaining: row.quota_limit - row.quota_used };
}

/** Decrement a session's quota by one. Returns false if exhausted/absent. */
export async function consumeSession(sessionId: string): Promise<boolean> {
  const res = await withClient(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE mcp_paid_sessions SET quota_used = quota_used + 1
       WHERE session_id = $1 AND expires_at > NOW() AND quota_used < quota_limit`,
      [sessionId],
    );
    return (rowCount ?? 0) > 0;
  });
  return res ?? true; // no DB → allow (dev)
}

export interface SettleResult {
  ok: boolean;
  receipt?: PaymentReceipt;
  session?: PaidSession;
  error?: string;
  hint?: string;
}

/**
 * Settle a payment for a tier from raw request headers (legacy REST path).
 * Delegates to settleSelection — the one settlement core.
 */
export async function settlePayment(
  userId: string,
  tier: PriceTier,
  headers: Headers,
  proof?: string,
): Promise<SettleResult> {
  return settleSelection(userId, tier, parseSelection(headers), proof);
}

/**
 * Settle a payment for a tier using an explicit network selection (MCP path:
 * the `payments.settle` tool passes the agent's chosen chain/rail/asset), then
 * open a session bundling SESSION_QUOTA queries.
 *
 * Rail is credential-driven: real n-payment settlement when configured, else a
 * deterministic mock. Safety: the mock rail NEVER grants paid sessions in
 * production — real settlement is the only way to unlock a paid tier in prod.
 */
export async function settleSelection(
  userId: string,
  tier: PriceTier,
  selection: Partial<PaymentSelection>,
  proof?: string,
): Promise<SettleResult> {
  const validated = validateSelection(selection);
  if (!validated.ok) return { ok: false, error: validated.error.message, hint: validated.error.hint };

  const sel: PaymentSelection = validated.data;
  const amount = TIER_PRICE_USD[tier];
  const rail = selectRail(sel);

  if (process.env.NODE_ENV === 'production' && rail.isMock) {
    return { ok: false, error: 'payment_rail_not_live', hint: 'configure n-payment (MCP_FACILITATOR_PRIVATE_KEY + PAY_TO_ADDRESS) to enable real settlement' };
  }

  const settled = await rail.settle({ selection: sel, amount, userId, proof });
  if (!settled.ok) return { ok: false, error: settled.error.message, hint: settled.error.hint };

  const sessionId = await openSession(userId, tier, sel, amount, settled.data.txHash);
  return {
    ok: true,
    receipt: settled.data,
    session: { sessionId, tier, chain: sel.chain, quotaRemaining: SESSION_QUOTA },
  };
}

async function openSession(userId: string, tier: PriceTier, sel: PaymentSelection, amount: string, txHash: string): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{ session_id: string }>(
      `INSERT INTO mcp_paid_sessions (user_id, tier, chain, rail, amount, quota_limit, tx_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING session_id`,
      [userId, tier, sel.chain, sel.rail, amount, SESSION_QUOTA, txHash, expiresAt],
    );
    return rows[0]?.session_id ?? null;
  });
  return row ?? `mock-session-${txHash.slice(2, 10)}`;
}
