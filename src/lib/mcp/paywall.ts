/**
 * src/lib/mcp/paywall.ts
 * ----------------------
 * Tiered pricing + the x402/MPP challenge + session-bundled billing. Depends on
 * the PaymentRail interface (payment-router) — never on a concrete rail.
 *
 * Session-bundled billing: one on-chain settlement covers up to 100 queries at
 * a tier, so per-query gas overhead stays viable (pre-mortem PT3).
 *
 * Monetization model: 5 free calls / 24h (rate-limit.ts), then per-call
 * settlement here across x402/mpp on EVM-USDC / XRPL-RLUSD / GOAT-USDC /
 * Stellar-USDC. There is no subscription tier — one clean per-call path.
 */

import { randomUUID } from 'node:crypto';
import { withClient } from '../db';
import { isMcpDreamPaymentBindingEnabled } from '../platform-flag';
import type { PriceTier } from './catalog';
import {
  parseSelection,
  selectRail,
  supportedNetworks,
  validateSelection,
  validateConfidentialSelection,
  validateDreamSelection,
  type PaymentReceipt,
  type PaymentSelection,
} from './payment-router';

export const TIER_PRICE_USD: Record<PriceTier, string> = {
  t1_read: '0.001',
  t2_realtime: '0.01',
  t3_vector: '0.10',
  confidential: '0.50', // attestation-gated Flare confidential execution, XRPL-settled only
  dream: '0.05', // XRPL RLUSD-paid memory consolidation pass
};

const SESSION_QUOTA = 100;
const SESSION_TTL_MS = 3_600_000; // 1 hour

/** The x402 payment-required challenge (advertises the full selection matrix). */
export function buildChallenge(tier: PriceTier, resetInHours: number) {
  // The confidential tier settles exclusively via XRPL (Sub-PRD C) — narrow
  // the advertised chains so a well-behaved agent client sees the right
  // options up front instead of discovering the restriction only after a
  // failed attempt. Every other tier's challenge is unchanged.
  const nets = tier === 'confidential' || tier === 'dream'
    ? supportedNetworks().filter((n) => n.chain.startsWith('xrpl'))
    : supportedNetworks();
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
  agentId?: string;
}

export interface PaymentQuote {
  quoteId: string;
  agentId: string;
  tier: PriceTier;
  chain: string;
  rail: 'x402' | 'mpp';
  asset: string;
  merchant: string;
  amount: string;
  currency: string;
  issuer: string;
  nonce: string;
  expiresAt: string;
  docsUrl: string;
}

type QuoteRow = PaymentQuote & { userId: string; settledAt?: string; sessionId?: string };
const localQuotes = new Map<string, QuoteRow>();

function quoteTtlMs(): number {
  const value = Number(process.env.MCP_XRPL_QUOTE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 600_000;
}

function quoteError(message: string, hint?: string) {
  return { ok: false as const, error: message, hint };
}

/** Issue the complete payment terms before a wallet is asked to sign. */
export async function issuePaymentQuote(
  userId: string,
  input: { tier: PriceTier; chain: string; asset?: string; agentId: string },
): Promise<{ ok: true; quote: PaymentQuote } | { ok: false; error: string; hint?: string }> {
  if (!(input.tier in TIER_PRICE_USD)) return quoteError(`unknown tier "${input.tier}"`);
  if (!input.agentId) return quoteError('agent_id is required');
  const validated = input.tier === 'dream'
    ? validateDreamSelection({ chain: input.chain, rail: 'x402', asset: input.asset ?? 'RLUSD' })
    : validateSelection({ chain: input.chain, rail: 'x402', asset: input.asset });
  if (!validated.ok) return quoteError(validated.error.message, validated.error.hint);
  if (!validated.data.chain.startsWith('xrpl') || validated.data.asset !== 'RLUSD') {
    return quoteError('quote-first settlement is currently required for XRPL RLUSD payments');
  }
  const merchant = process.env.XRPL_TREASURY_ADDRESS?.trim();
  const issuer = process.env.XRPL_RLUSD_ISSUER?.trim();
  if (!merchant || !issuer) return quoteError('XRPL payment quoting is not configured', 'set XRPL_TREASURY_ADDRESS and XRPL_RLUSD_ISSUER');
  const quote: PaymentQuote = {
    quoteId: randomUUID(), agentId: input.agentId, tier: input.tier, chain: validated.data.chain,
    rail: validated.data.rail, asset: 'RLUSD', merchant, amount: TIER_PRICE_USD[input.tier],
    currency: 'RLUSD', issuer, nonce: randomUUID().replaceAll('-', ''),
    expiresAt: new Date(Date.now() + quoteTtlMs()).toISOString(),
    docsUrl: 'https://xrpl.org/docs/agents/agentic-payments-x402',
  };
  const row = await withClient(async (client) => {
    await client.query(
      `INSERT INTO mcp_payment_quotes (quote_id, user_id, agent_id, tier, chain, rail, asset, merchant, amount, currency, issuer, nonce, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [quote.quoteId, userId, quote.agentId, quote.tier, quote.chain, quote.rail, quote.asset, quote.merchant, quote.amount, quote.currency, quote.issuer, quote.nonce, quote.expiresAt],
    );
    return true;
  });
  if (row === null) localQuotes.set(quote.quoteId, { ...quote, userId });
  return { ok: true, quote };
}

async function loadQuote(userId: string, quoteId: string): Promise<QuoteRow | null> {
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{
      quote_id: string; user_id: string; agent_id: string; tier: PriceTier; chain: string; rail: 'x402' | 'mpp'; asset: string;
      merchant: string; amount: string; currency: string; issuer: string; nonce: string; expires_at: string; settled_at: string | null; session_id: string | null;
    }>(`SELECT quote_id, user_id, agent_id, tier, chain, rail, asset, merchant, amount, currency, issuer, nonce, expires_at::text, settled_at::text, session_id
       FROM mcp_payment_quotes WHERE quote_id = $1 AND user_id = $2 LIMIT 1`, [quoteId, userId]);
    const q = rows[0];
    return q ? { quoteId: q.quote_id, userId: q.user_id, agentId: q.agent_id, tier: q.tier, chain: q.chain, rail: q.rail, asset: q.asset, merchant: q.merchant, amount: q.amount, currency: q.currency, issuer: q.issuer, nonce: q.nonce, expiresAt: q.expires_at, docsUrl: 'https://xrpl.org/docs/agents/agentic-payments-x402', settledAt: q.settled_at ?? undefined, sessionId: q.session_id ?? undefined } : null;
  });
  return row ?? localQuotes.get(quoteId) ?? null;
}

/** Reuse an active paid session for this tier if one exists with quota left. */
export async function findActiveSession(userId: string, tier: PriceTier, agentId?: string): Promise<PaidSession | null> {
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{ session_id: string; chain: string; quota_limit: number; quota_used: number; agent_id: string | null }>(
      `SELECT session_id, chain, quota_limit, quota_used, agent_id FROM mcp_paid_sessions
       WHERE user_id = $1 AND tier = $2 AND ($3::text IS NULL OR agent_id = $3) AND expires_at > NOW() AND quota_used < quota_limit
       ORDER BY created_at DESC LIMIT 1`,
      [userId, tier, agentId ?? null],
    );
    return rows[0] ?? null;
  });
  if (!row) return null;
  return { sessionId: row.session_id, tier, chain: row.chain, quotaRemaining: row.quota_limit - row.quota_used, ...(row.agent_id ? { agentId: row.agent_id } : {}) };
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

/** Read a durable session without leaking another caller's payment metadata. */
export async function getPaymentStatus(userId: string, filter: { sessionId?: string; agentId?: string }) {
  if (!filter.sessionId && !filter.agentId) return null;
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{
      session_id: string; tier: PriceTier; chain: string; rail: string; payer: string | null; quote_id: string | null;
      receipt: PaymentReceipt | null; expires_at: string; quota_limit: number; quota_used: number; agent_id: string | null;
    }>(`SELECT session_id, tier, chain, rail, payer, quote_id, receipt, expires_at::text, quota_limit, quota_used, agent_id
        FROM mcp_paid_sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR session_id = $2) AND ($3::text IS NULL OR agent_id = $3)
        ORDER BY created_at DESC LIMIT 1`, [userId, filter.sessionId ?? null, filter.agentId ?? null]);
    return rows[0] ?? null;
  });
  if (!row) return null;
  return { active: Date.parse(row.expires_at) > Date.now() && row.quota_used < row.quota_limit, sessionId: row.session_id, tier: row.tier, chain: row.chain, rail: row.rail, payer: row.payer, quoteId: row.quote_id, receipt: row.receipt, expiresAt: row.expires_at, remainingBudgetUsd: Math.max(0, row.quota_limit - row.quota_used), agentId: row.agent_id };
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
  sessionMeta?: { agentId?: string; quoteId?: string; merchant?: string; issuer?: string; nonce?: string },
): Promise<SettleResult> {
  const validated = tier === 'dream'
    ? validateDreamSelection(selection)
    : tier === 'confidential' ? validateConfidentialSelection(selection) : validateSelection(selection);
  if (!validated.ok) return { ok: false, error: validated.error.message, hint: validated.error.hint };

  const sel: PaymentSelection = validated.data;
  const amount = TIER_PRICE_USD[tier];
  const rail = selectRail(sel);

  if (process.env.NODE_ENV === 'production' && rail.isMock) {
    // Chain-specific hint (fixed 2026-08-12 — see npayment-rails.ts's
    // isRealPaymentsConfigured() doc comment): XRPL/RLUSD settlement never
    // uses MCP_FACILITATOR_PRIVATE_KEY/PAY_TO_ADDRESS, so naming those two
    // for an XRPL selection actively misled operators into configuring the
    // wrong variables. See lessons-learned.md's 2026-08-12 entry.
    const hint = sel.chain.startsWith('xrpl')
      ? 'configure n-payment for XRPL settlement (set XRPL_TREASURY_ADDRESS) to enable real settlement'
      : 'configure n-payment (MCP_FACILITATOR_PRIVATE_KEY + PAY_TO_ADDRESS) to enable real settlement';
    return { ok: false, error: 'payment_rail_not_live', hint };
  }

  const settled = await rail.settle({ selection: sel, amount, userId, tier, proof, ...(sessionMeta?.merchant && sessionMeta.issuer && sessionMeta.nonce ? { paymentTerms: { merchant: sessionMeta.merchant, issuer: sessionMeta.issuer, nonce: sessionMeta.nonce } } : {}) });
  if (!settled.ok) return { ok: false, error: settled.error.message, hint: settled.error.hint };

  const sessionId = await openSession(userId, tier, sel, amount, settled.data.txHash, {
    ...sessionMeta, payer: settled.data.payer, receipt: settled.data,
  });
  return {
    ok: true,
    receipt: settled.data,
    session: { sessionId, tier, chain: sel.chain, quotaRemaining: SESSION_QUOTA },
  };
}

/** Settle a previously disclosed quote. A quote is single-use and user-bound. */
export async function settleQuote(userId: string, quoteId: string, proof?: string): Promise<SettleResult & { quote?: PaymentQuote }> {
  const quote = await loadQuote(userId, quoteId);
  if (!quote) return { ok: false, error: 'payment quote was not found' };
  if (quote.settledAt || quote.sessionId) return { ok: false, error: 'payment quote has already been settled' };
  if (Date.parse(quote.expiresAt) <= Date.now()) return { ok: false, error: 'payment quote has expired', hint: 'request a new payments.quote before signing' };
  // Quote metadata is always retained for auditing, but the on-ledger memo
  // requirement is deliberately opt-in. The binding flag exists to make the
  // rollout reversible for existing XRPL clients that submit a valid payment
  // without a Memo field. When enabled, only Dream quotes require the nonce.
  const requireQuoteMemo = quote.tier === 'dream' && isMcpDreamPaymentBindingEnabled();
  const result = await settleSelection(
    userId,
    quote.tier,
    { chain: quote.chain, rail: quote.rail, asset: quote.asset },
    proof,
    {
      agentId: quote.agentId,
      quoteId: quote.quoteId,
      ...(requireQuoteMemo ? { merchant: quote.merchant, issuer: quote.issuer, nonce: quote.nonce } : {}),
    },
  );
  if (!result.ok) return result;
  if (!result.receipt?.payer) return { ok: false, error: 'settlement receipt is missing the XRPL payer address' };
  if (result.receipt.payer === quote.merchant) return { ok: false, error: 'self-payment is not a valid XRPL settlement' };
  await withClient(async (client) => {
    await client.query(`UPDATE mcp_payment_quotes SET settled_at = NOW(), session_id = $1 WHERE quote_id = $2 AND user_id = $3 AND settled_at IS NULL`, [result.session?.sessionId ?? null, quoteId, userId]);
    return true;
  });
  const local = localQuotes.get(quoteId);
  if (local) { local.settledAt = new Date().toISOString(); local.sessionId = result.session?.sessionId; }
  return { ...result, quote };
}

async function openSession(userId: string, tier: PriceTier, sel: PaymentSelection, amount: string, txHash: string, meta?: { agentId?: string; quoteId?: string; payer?: string; receipt?: PaymentReceipt }): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{ session_id: string }>(
      `INSERT INTO mcp_paid_sessions (user_id, tier, chain, rail, amount, quota_limit, tx_hash, expires_at, agent_id, quote_id, payer, receipt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING session_id`,
      [userId, tier, sel.chain, sel.rail, amount, SESSION_QUOTA, txHash, expiresAt, meta?.agentId ?? null, meta?.quoteId ?? null, meta?.payer ?? null, meta?.receipt ? JSON.stringify(meta.receipt) : null],
    );
    return rows[0]?.session_id ?? null;
  });
  return row ?? `mock-session-${txHash.slice(2, 10)}`;
}
