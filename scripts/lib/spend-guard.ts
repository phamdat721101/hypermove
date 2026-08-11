/**
 * scripts/lib/spend-guard.ts
 * ---------------------------
 * Shared max-spend safety guard for any script that can submit a REAL
 * on-chain payment (testnet or mainnet). Added as part of the 2026-08-11
 * Dream Cycle/FCC/RLUSD status-review upgrade — even though today's only
 * caller (scripts/demo-t54-rlusd-dream-cycle.ts) only ever runs against
 * XRPL *testnet*, the review's own Q&A explicitly asked for this guard on
 * testnet too: cheap to add, and it establishes the pattern before any
 * future live-fund script (e.g. scripts/smoke-live-deployment.ts) forgets
 * to add one.
 *
 * Deliberately framework-free — a single pure function, no dependency on
 * nim-skill, vitest, or any script-specific state — so it can be imported
 * and unit-tested in complete isolation.
 */

export interface SpendGuardOptions {
  /** The ceiling, in USD-equivalent (RLUSD is USD-pegged 1:1), above which
   *  a live payment is refused. Defaults to $0.10 per the plan's Q&A. */
  maxUsd?: number;
}

export class SpendGuardExceededError extends Error {
  readonly amountUsd: number;
  readonly maxUsd: number;

  constructor(amountUsd: number, maxUsd: number) {
    super(
      `Refusing to submit a live payment of $${amountUsd} — exceeds the configured max-spend guard of ` +
        `$${maxUsd} (override via MAX_LIVE_SPEND_USD if this is genuinely intended).`,
    );
    this.name = 'SpendGuardExceededError';
    this.amountUsd = amountUsd;
    this.maxUsd = maxUsd;
  }
}

/** Default ceiling per the plan's Q&A (item 8): $0.10, overridable via
 *  MAX_LIVE_SPEND_USD so a deliberate one-off larger amount doesn't require
 *  editing source, but always requires an explicit, visible env var. */
export function resolveMaxLiveSpendUsd(): number {
  const raw = process.env.MAX_LIVE_SPEND_USD;
  if (raw === undefined || raw === '') return 0.1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`MAX_LIVE_SPEND_USD="${raw}" is not a valid non-negative number.`);
  }
  return parsed;
}

/**
 * Throws SpendGuardExceededError if `amountUsd` exceeds the configured
 * ceiling. Accepts a string or number for `amountUsd` since every caller in
 * this repo sources amounts from either a CLI/env string (e.g.
 * PRICE_RLUSD='0.05') or an already-parsed number — normalizing here keeps
 * every call site a single line instead of repeating `Number(...)` checks.
 *
 * RLUSD is USD-pegged 1:1 (see README.md's "Why RLUSD on XRPL" section), so
 * a plain numeric comparison against a USD ceiling is correct without a
 * currency-conversion step.
 */
export function assertWithinSpendGuard(amountUsd: string | number, options: SpendGuardOptions = {}): void {
  const amount = typeof amountUsd === 'string' ? Number(amountUsd) : amountUsd;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`assertWithinSpendGuard: amountUsd="${amountUsd}" is not a valid non-negative number.`);
  }
  const maxUsd = options.maxUsd ?? resolveMaxLiveSpendUsd();
  if (amount > maxUsd) {
    throw new SpendGuardExceededError(amount, maxUsd);
  }
}
