/**
 * tests/mcp-calls-cost-columns.test.ts
 * -------------------------------------
 * Task 5 (v2.1 guardrails/cost-accounting plan): mcp_calls gets two new
 * nullable columns, tokens_used/cost_usd. Skips gracefully when DATABASE_URL
 * is unset (no real Postgres available) — matches this repo's existing
 * Testcontainers-optional convention; does not fail the suite either way.
 */
import { describe, it, expect } from 'vitest';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)('mcp_calls tokens_used/cost_usd columns (requires DATABASE_URL)', () => {
  it('round-trips NULL and real numeric values; the idempotent migration re-applies cleanly on every withClient() call', async () => {
    const { withClient } = await import('@/lib/db');
    // ensureSchema() runs automatically inside every withClient() call (see
    // db.ts) — calling withClient twice in a row here doubles as proof the
    // ALTER TABLE ... ADD COLUMN IF NOT EXISTS pair is a clean no-op on
    // re-run, not just on first-ever creation.
    await withClient(async (client) => { await client.query('SELECT 1'); return true; });
    await withClient(async (client) => { await client.query('SELECT 1'); return true; });

    const nullRow = await withClient(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO mcp_calls (user_id, tool_name, params_hash, outcome)
         VALUES ('test-user', 'search', 'hash1', 'ok') RETURNING tokens_used, cost_usd`,
      );
      return rows[0];
    });
    expect(nullRow.tokens_used).toBeNull();
    expect(nullRow.cost_usd).toBeNull();

    const realRow = await withClient(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO mcp_calls (user_id, tool_name, params_hash, outcome, tokens_used, cost_usd)
         VALUES ('test-user', 'start_dream', 'hash2', 'ok', 150, 0.000042) RETURNING tokens_used, cost_usd`,
      );
      return rows[0];
    });
    expect(realRow.tokens_used).toBe(150);
    expect(Number(realRow.cost_usd)).toBeCloseTo(0.000042, 6);
  });
});

describe.skipIf(hasDb)('mcp_calls tokens_used/cost_usd columns (skipped — no DATABASE_URL)', () => {
  it('is skipped without a real Postgres instance', () => {
    expect(hasDb).toBe(false);
  });
});
