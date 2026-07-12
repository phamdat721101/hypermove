/**
 * src/lib/mcp/paywall.ts
 * ----------------------
 * Tiered pricing + the x402/MPP challenge + session-bundled billing. Depends on
 * the PaymentRail interface (payment-router) — never on a concrete rail.
 *
 * Session-bundled billing: one on-chain settlement covers up to 100 queries at
 * a tier, so per-query gas overhead stays viable (pre-mortem PT3).
 */

import { randomUUID } from 'node:crypto';
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

// ─── XRPL Pro: 30-day time-boxed entitlement (RLUSD/x402) ─────────────────
//
// Subscription-as-prepaid-x402: one $5 RLUSD payment → one 30-day Pro window
// with a monthly Exa-query cap. This module owns the entitlement table (SRP),
// including the per-entitlement quota counter (kept here, not in rate-limit.ts,
// so the counter lives with the row it mutates).

export const PRO_PRICE_USD = '5';
export const PRO_TIER = 'xrpl-pro';
const PRO_WINDOW_DAYS = 30;
const PRO_MONTHLY_CAP = 200;

export interface ProEntitlement {
  userId: string;
  wallet: string | null;
  tier: string;
  expiresAt: string;
  queriesUsed: number;
  monthlyQueryCap: number;
}

/** HyperMove XRPL source tag (stamped on RLUSD payments for attribution). */
const HM_SOURCE_TAG = 402;

/**
 * The 402 challenge advertising the $5-in-RLUSD-on-XRPL Pro package as a real
 * x402 PAYMENT-REQUIRED envelope (base64) the buyer/agent can sign against.
 * Async because it lazy-imports the (heavy) n-payment SDK for the wire codecs.
 */
export async function buildProChallenge(userId = 'anonymous') {
  const network = process.env.XRPL_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const chain = network === 'mainnet' ? 'xrpl-mainnet' : 'xrpl-testnet';
  const caip2 = network === 'mainnet' ? 'xrpl:0' : 'xrpl:1';
  const payTo = process.env.XRPL_TREASURY_ADDRESS;

  const base = {
    ok: false as const,
    status: 402 as const,
    error: 'payment_required' as const,
    package: '$5/month',
    amount: PRO_PRICE_USD,
    asset: 'RLUSD',
    chain,
    rail: 'x402',
    entitlement: `${PRO_WINDOW_DAYS}-day`,
    monthlyQueryCap: PRO_MONTHLY_CAP,
    settle_via: 'payments.upgrade_xrpl_pro',
    altMethods: ['btc-on-goat'],
    hint: 'Sign a 5 RLUSD XRPL Payment for the advertised requirements, then call payments.upgrade_xrpl_pro with the base64 PAYMENT-SIGNATURE as `proof`.',
  };

  if (!payTo) return { ...base, paymentRequiredHeader: null as string | null };

  try {
    const np = await import('n-payment');
    const requirements = {
      scheme: 'exact' as const,
      network: caip2 as 'xrpl:0' | 'xrpl:1',
      asset: np.RLUSD_HEX,
      payTo,
      amount: PRO_PRICE_USD,
      maxTimeoutSeconds: 3600,
      extra: {
        sourceTag: HM_SOURCE_TAG,
        invoiceId: `hm-pro:${userId}:${randomUUID()}`,
        issuer: np.getRlusdIssuer(network),
      },
    };
    const paymentRequiredHeader = np.encodePaymentRequiredHeader({ x402Version: 2, accepts: [requirements] });
    return { ...base, accepts: [requirements], paymentRequiredHeader };
  } catch {
    return { ...base, paymentRequiredHeader: null as string | null };
  }
}

const row2entitlement = (r: {
  user_id: string; wallet: string | null; tier: string; expires_at: string; queries_used: number; monthly_query_cap: number;
}): ProEntitlement => ({
  userId: r.user_id, wallet: r.wallet, tier: r.tier,
  expiresAt: r.expires_at, queriesUsed: r.queries_used, monthlyQueryCap: r.monthly_query_cap,
});

/** The active (unexpired) Pro entitlement for a user, if any. */
export async function findActiveEntitlement(userId: string): Promise<ProEntitlement | null> {
  const row = await withClient(async (client) => {
    const { rows } = await client.query<Parameters<typeof row2entitlement>[0]>(
      `SELECT user_id, wallet, tier, expires_at::text, queries_used, monthly_query_cap
       FROM mcp_pro_entitlements
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  });
  return row ? row2entitlement(row) : null;
}

/**
 * Mint (or return the existing) 30-day Pro entitlement for a settled payment.
 * Idempotent on payment_tx — replaying the same settlement proof never mints a
 * second window. No DB (dev) → returns a synthetic entitlement so mock-mode
 * flows work end-to-end within the process.
 */
export async function mintEntitlement(userId: string, wallet: string | null, paymentTx: string): Promise<ProEntitlement> {
  const expiresAt = new Date(Date.now() + PRO_WINDOW_DAYS * 86_400_000).toISOString();
  const synthetic: ProEntitlement = {
    userId, wallet, tier: PRO_TIER, expiresAt, queriesUsed: 0, monthlyQueryCap: PRO_MONTHLY_CAP,
  };
  const row = await withClient(async (client) => {
    const { rows } = await client.query<Parameters<typeof row2entitlement>[0]>(
      `INSERT INTO mcp_pro_entitlements (user_id, wallet, tier, expires_at, payment_tx, monthly_query_cap, cap_reset_at)
       VALUES ($1,$2,$3,$4,$5,$6,$4)
       ON CONFLICT (payment_tx) DO NOTHING
       RETURNING user_id, wallet, tier, expires_at::text, queries_used, monthly_query_cap`,
      [userId, wallet, PRO_TIER, expiresAt, paymentTx, PRO_MONTHLY_CAP],
    );
    if (rows[0]) return rows[0];
    // Conflict: the tx was already settled — return the existing entitlement.
    const { rows: existing } = await client.query<Parameters<typeof row2entitlement>[0]>(
      `SELECT user_id, wallet, tier, expires_at::text, queries_used, monthly_query_cap
       FROM mcp_pro_entitlements WHERE payment_tx = $1 LIMIT 1`,
      [paymentTx],
    );
    return existing[0] ?? null;
  });
  return row ? row2entitlement(row) : synthetic;
}

export interface QuotaResult { allowed: boolean; used: number; cap: number; }

/**
 * Consume one Pro query against the active entitlement's monthly cap. Rolls the
 * counter over when the 30-day window resets. No DB (dev) → always allowed.
 */
export async function consumeEntitlementQuota(userId: string): Promise<QuotaResult> {
  const res = await withClient(async (client) => {
    // Reset the counter if the cap window elapsed.
    await client.query(
      `UPDATE mcp_pro_entitlements
       SET queries_used = 0, cap_reset_at = NOW() + INTERVAL '${PRO_WINDOW_DAYS} days'
       WHERE user_id = $1 AND expires_at > NOW() AND cap_reset_at <= NOW()`,
      [userId],
    );
    const { rows } = await client.query<{ queries_used: number; monthly_query_cap: number }>(
      `UPDATE mcp_pro_entitlements
       SET queries_used = queries_used + 1
       WHERE id = (
         SELECT id FROM mcp_pro_entitlements
         WHERE user_id = $1 AND expires_at > NOW() AND queries_used < monthly_query_cap
         ORDER BY expires_at DESC LIMIT 1
       )
       RETURNING queries_used, monthly_query_cap`,
      [userId],
    );
    if (rows[0]) return { allowed: true, used: rows[0].queries_used, cap: rows[0].monthly_query_cap };
    return { allowed: false, used: PRO_MONTHLY_CAP, cap: PRO_MONTHLY_CAP };
  });
  return res ?? { allowed: true, used: 0, cap: PRO_MONTHLY_CAP }; // no DB → allow (dev)
}

export interface ProSettleResult {
  ok: boolean;
  entitlement?: ProEntitlement;
  receipt?: PaymentReceipt;
  error?: string;
  hint?: string;
}

/**
 * Settle a $5 RLUSD/x402 payment on XRPL and mint the 30-day Pro entitlement.
 * Reuses the payment-router rail selection + n-payment settlement (the XRPL
 * branch in npayment-rails). One code path for both the agent 402 flow and the
 * human Upgrade UI.
 */
export async function settleProEntitlement(
  userId: string,
  selection: Partial<PaymentSelection>,
  proof?: string,
): Promise<ProSettleResult> {
  const validated = validateSelection({ chain: selection.chain, rail: selection.rail ?? 'x402', asset: selection.asset ?? 'RLUSD' });
  if (!validated.ok) return { ok: false, error: validated.error.message, hint: validated.error.hint };

  const sel = validated.data;
  if (!sel.chain.startsWith('xrpl') || sel.asset !== 'RLUSD') {
    return { ok: false, error: 'unsupported_selection', hint: 'XRPL Pro requires chain=xrpl-* and asset=RLUSD' };
  }

  const rail = selectRail(sel);
  if (process.env.NODE_ENV === 'production' && rail.isMock) {
    return { ok: false, error: 'payment_rail_not_live', hint: 'configure XRPL RLUSD settlement to enable real Pro upgrades' };
  }

  const settled = await rail.settle({ selection: sel, amount: PRO_PRICE_USD, userId, proof });
  if (!settled.ok) return { ok: false, error: settled.error.message, hint: settled.error.hint };

  const entitlement = await mintEntitlement(userId, settled.data.payer ?? null, settled.data.txHash);
  return { ok: true, entitlement, receipt: settled.data };
}
