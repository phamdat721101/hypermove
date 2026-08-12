/**
 * tests/mcp-xrpl-settlement.test.ts
 * ------------------------------------
 * 2026-08-10, xrpl-rlusd-settlement-gap-feedback PRD 04. End-to-end
 * conformance coverage for src/lib/mcp/npayment-rails.ts's XRPL/RLUSD
 * settlement rail — confirmed via `grep -r settleXrplRlusd|XrplFacilitatorClient
 * tests/` during planning that ZERO test coverage existed for this function
 * before this file, despite it containing real security logic (payTo/asset/
 * amount binding against buyer-echoed or on-chain-verified terms).
 *
 * Three tiers:
 *   1. Mocked unit tests (this file's main body) — always run, no network,
 *      no real funds. Covers both settlement paths: the pre-existing
 *      facilitator-relay envelope path AND the new (2026-08-10, PRD 03)
 *      already-submitted-txHash path, including its replay protection.
 *   2. Live testnet integration test — gated behind
 *      RUN_LIVE_XRPL_TESTS=true, reads scripts/.env.rlusd-demo for
 *      RLUSD_DEMO_SEED (same var name scripts/demo-t54-rlusd-dream-cycle.ts
 *      already uses), submits a REAL testnet Payment, then settles it
 *      end-to-end via payments.settle's real handler chain. Never runs by
 *      default — no funded wallet is assumed present in CI.
 *   3. Mainnet smoke test — gated behind RUN_LIVE_XRPL_MAINNET_TESTS=true
 *      (default OFF, never auto-run). Manual pre-release gate only: before
 *      any release touching npayment-rails.ts's XRPL path, run this once by
 *      hand with a real, minimal RLUSD amount on xrpl-mainnet and record the
 *      resulting tx hash + receipt as evidence (mirroring this repo's
 *      existing published-testnet-tx-hash discipline in README.md). This
 *      tier is NOT part of automated CI and was NOT executed as part of
 *      shipping this file — see docs/prd/ for the as-built doc's explicit
 *      note on this.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV_KEYS = ['XRPL_TREASURY_ADDRESS', 'XRPL_FACILITATOR_URL', 'DATABASE_URL', 'MCP_FACILITATOR_PRIVATE_KEY', 'PAY_TO_ADDRESS'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.XRPL_TREASURY_ADDRESS = 'rTreasuryAddr11111111111111111111';
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.doUnmock('n-payment');
  vi.doUnmock('../src/lib/db');
});

const TREASURY = 'rTreasuryAddr11111111111111111111';
const RLUSD_HEX = '524C555344000000000000000000000000000000';

/** Minimal in-memory fake for withClient — mirrors every other dream/*
 *  test file's convention (mcp-dream-cycle.test.ts etc.). */
function installFakeSettledTxsDb() {
  const rows: { tx_hash: string; chain: string; tier: string; expires_at: string }[] = [];
  vi.doMock('../src/lib/db', () => ({
    withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      const client = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('SELECT tx_hash FROM mcp_xrpl_settled_txs')) {
            const [txHash] = params as [string];
            const found = rows.find((r) => r.tx_hash === txHash && new Date(r.expires_at) > new Date());
            return { rows: found ? [{ tx_hash: found.tx_hash }] : [] };
          }
          if (sql.includes('INSERT INTO mcp_xrpl_settled_txs')) {
            const [txHash, chain, tier, expiresAt] = params as [string, string, string, string];
            if (rows.some((r) => r.tx_hash === txHash)) return { rowCount: 0 };
            rows.push({ tx_hash: txHash, chain, tier, expires_at: expiresAt });
            return { rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      };
      return fn(client);
    }),
  }));
  return rows;
}

/** Mocks n-payment's XrplConnection.getClient().request({command:'tx',...})
 *  to return a specific, controllable transaction lookup result. */
function mockXrplTxLookup(result: {
  validated?: boolean;
  Destination?: string;
  Account?: string;
  engineResult?: string;
  deliveredCurrency?: string;
  deliveredValue?: string;
}) {
  const requestMock = vi.fn(async () => ({
    result: {
      validated: result.validated ?? true,
      Destination: result.Destination ?? TREASURY,
      Account: result.Account ?? 'rPayerAddr222222222222222222222222',
      meta: {
        TransactionResult: result.engineResult ?? 'tesSUCCESS',
        delivered_amount: { currency: result.deliveredCurrency ?? RLUSD_HEX, value: result.deliveredValue ?? '0.50' },
      },
    },
  }));
  vi.doMock('n-payment', () => ({
    RLUSD_HEX,
    RLUSD_CURRENCY: RLUSD_HEX,
    defaultFacilitatorUrl: (network: string) => `https://xrpl-facilitator-${network}.t54.ai`,
    decodePaymentSignatureHeader: vi.fn((raw: string) => {
      const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      return parsed;
    }),
    XrplFacilitatorClient: class {
      async settle() {
        return { success: true, transaction: 'FACILITATOR-RELAYED-TX-HASH-000000000000000000000000000000', payer: 'rPayerAddr222222222222222222222222' };
      }
    },
    XrplConnection: class {
      async getClient() {
        return { request: requestMock };
      }
      async disconnect() {}
    },
  }));
  return requestMock;
}

function validEnvelopeProof(overrides: Partial<{ payTo: string; asset: string; amount: string }> = {}): string {
  const envelope = {
    accepted: { payTo: overrides.payTo ?? TREASURY, asset: overrides.asset ?? RLUSD_HEX, amount: overrides.amount ?? '0.50' },
  };
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

// ─── Tier 1a: pre-existing facilitator-relay envelope path (regression coverage) ───

describe('Tier 1a · settleXrplRlusd — facilitator-relay envelope path (pre-existing, regression coverage)', () => {
  it('valid envelope with matching payTo/asset/amount settles successfully', async () => {
    mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const res = await rail.settle({
      selection: { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: validEnvelopeProof(),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.txHash).toBe('FACILITATOR-RELAYED-TX-HASH-000000000000000000000000000000');
  });

  it('envelope with mismatched payTo fails', async () => {
    mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const res = await rail.settle({
      selection: { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: validEnvelopeProof({ payTo: 'rSomeoneElse11111111111111111111' }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('settle_failed');
  });

  it('envelope with wrong asset (e.g. USDC on an RLUSD-priced tier) fails', async () => {
    mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const res = await rail.settle({
      selection: { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: validEnvelopeProof({ asset: 'USDC' }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('settle_failed');
  });

  it('envelope with amount below the required price (beyond the $0.01 tolerance) fails', async () => {
    mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const res = await rail.settle({
      selection: { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: validEnvelopeProof({ amount: '0.10' }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('settle_failed');
  });

  it('malformed/undecodable proof fails with a generic decode error, not wrong_proof_shape', async () => {
    mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const res = await rail.settle({
      selection: { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: 'not-valid-base64-json-!!!',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('settle_failed');
  });

  it('missing proof fails with no_proof', async () => {
    mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const res = await rail.settle({
      selection: { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('no_proof');
  });
});

// ─── Tier 1b: PRD 02 — proof shape disambiguation ──────────────────────────

describe('Tier 1b · settleXrplRlusd — PRD 02 proof shape disambiguation', () => {
  it('a bare 64-hex-char proof (an XRPL tx hash) does NOT attempt envelope decode — routes to the txHash path instead', async () => {
    // Route to settleXrplAlreadySubmitted() with a validated tx — proves the
    // bare-hex shape is detected and routed correctly, not just rejected.
    installFakeSettledTxsDb();
    mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const bareHex = 'C9C74C7B59B02F99556D3E0EF0DB5B4AA4ECE9A1672F899BD66281A918C00B3B'; // 64 hex chars
    const res = await rail.settle({
      selection: { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: bareHex,
    });
    expect(res.ok).toBe(true); // proves routing worked — a real envelope-decode attempt on this hex string would have failed
  });

  it('a genuinely malformed envelope that also looks hex-like returns wrong_proof_shape, not a generic decode error', async () => {
    mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    // 40 hex chars — too short to match the strict 64-char TXHASH_SHAPE, but
    // still hex-only, so it exercises the decode-catch's own hex-heuristic
    // fallback (>= 32 hex chars) rather than the upfront shape check.
    const almostHex = 'AB'.repeat(20);
    const res = await rail.settle({
      selection: { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: almostHex,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('wrong_proof_shape');
      expect(res.error.hint).toMatch(/transaction hash/i);
      expect(res.error.hint).toMatch(/txHash/);
    }
  });

  it('JSON {"txHash": "..."} proof routes to the txHash path', async () => {
    installFakeSettledTxsDb();
    mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const txHash = 'C9C74C7B59B02F99556D3E0EF0DB5B4AA4ECE9A1672F899BD66281A918C00B3B';
    const res = await rail.settle({
      selection: { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: JSON.stringify({ txHash }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.txHash).toBe(txHash);
  });
});

// ─── Tier 1b.5: selectRail() chain-awareness regression (2026-08-12 fix) ──
//
// Prior to this fix, isRealPaymentsConfigured()/selectRail() applied a
// single EVM-shaped credential check (MCP_FACILITATOR_PRIVATE_KEY +
// PAY_TO_ADDRESS) to every chain, including XRPL — which never uses those
// two vars at all (settleXrplRlusd() only reads XRPL_TREASURY_ADDRESS). The
// bug: an XRPL selection with a correctly-configured XRPL_TREASURY_ADDRESS
// but no MCP_FACILITATOR_PRIVATE_KEY/PAY_TO_ADDRESS still silently resolved
// to MockPaymentRail, which production then refused outright
// (payment_rail_not_live) — with a hint naming the wrong two variables. See
// lessons-learned.md's 2026-08-12 entry for the live incident this
// regenerates.
describe('Tier 1b.5 · selectRail() chain-awareness (2026-08-12 regression)', () => {
  it('an XRPL selection with ONLY XRPL_TREASURY_ADDRESS set (no MCP_FACILITATOR_PRIVATE_KEY/PAY_TO_ADDRESS) resolves to the REAL rail, not mock', async () => {
    delete process.env.MCP_FACILITATOR_PRIVATE_KEY;
    delete process.env.PAY_TO_ADDRESS;
    // beforeEach() already sets a valid XRPL_TREASURY_ADDRESS.
    const { selectRail } = await import('../src/lib/mcp/payment-router');
    const rail = selectRail({ chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' });
    expect(rail.isMock).toBe(false);
  });

  it('an XRPL selection with NEITHER XRPL_TREASURY_ADDRESS NOR the EVM vars set resolves to the mock rail (fails closed, not open)', async () => {
    delete process.env.XRPL_TREASURY_ADDRESS;
    delete process.env.MCP_FACILITATOR_PRIVATE_KEY;
    delete process.env.PAY_TO_ADDRESS;
    const { selectRail } = await import('../src/lib/mcp/payment-router');
    const rail = selectRail({ chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' });
    expect(rail.isMock).toBe(true);
  });

  it('an EVM selection still requires MCP_FACILITATOR_PRIVATE_KEY + PAY_TO_ADDRESS (unchanged pre-fix behavior) — XRPL_TREASURY_ADDRESS alone is not enough', async () => {
    delete process.env.MCP_FACILITATOR_PRIVATE_KEY;
    delete process.env.PAY_TO_ADDRESS;
    // beforeEach() already sets XRPL_TREASURY_ADDRESS — must NOT leak into the EVM check.
    const { selectRail } = await import('../src/lib/mcp/payment-router');
    const rail = selectRail({ chain: 'base-sepolia', rail: 'x402', asset: 'USDC' });
    expect(rail.isMock).toBe(true);
  });

  it('an EVM selection with both EVM vars set resolves to the real rail, independent of XRPL_TREASURY_ADDRESS', async () => {
    process.env.MCP_FACILITATOR_PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';
    process.env.PAY_TO_ADDRESS = '0x000000000000000000000000000000000000dEaD';
    const { selectRail } = await import('../src/lib/mcp/payment-router');
    const rail = selectRail({ chain: 'base-sepolia', rail: 'x402', asset: 'USDC' });
    expect(rail.isMock).toBe(false);
  });
});

// ─── Tier 1c: PRD 03 — already-submitted txHash settlement path ───────────

describe('Tier 1c · settleXrplAlreadySubmitted — independent on-ledger verification + replay protection', () => {
  const TX_HASH = 'C9C74C7B59B02F99556D3E0EF0DB5B4AA4ECE9A1672F899BD66281A918C00B3B';

  async function settleWithTxHash(overrides: Parameters<typeof mockXrplTxLookup>[0] = {}) {
    installFakeSettledTxsDb();
    const requestMock = mockXrplTxLookup(overrides);
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const res = await rail.settle({
      selection: { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: JSON.stringify({ txHash: TX_HASH }),
    });
    return { res, requestMock };
  }

  it('a validated, tesSUCCESS transaction to the correct treasury with sufficient RLUSD settles successfully', async () => {
    const { res } = await settleWithTxHash({});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.txHash).toBe(TX_HASH);
      expect(res.data.payer).toBe('rPayerAddr222222222222222222222222');
    }
  });

  it('a mocked non-validated transaction fails', async () => {
    const { res } = await settleWithTxHash({ validated: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('settle_failed');
  });

  it('a mocked transaction with a non-tesSUCCESS engine result fails', async () => {
    const { res } = await settleWithTxHash({ engineResult: 'tecPATH_DRY' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('settle_failed');
  });

  it('a mocked transaction with the wrong destination fails', async () => {
    const { res } = await settleWithTxHash({ Destination: 'rWrongDestination111111111111111' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('settle_failed');
  });

  it('a mocked transaction delivering less than the required amount fails', async () => {
    const { res } = await settleWithTxHash({ deliveredValue: '0.10' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('settle_failed');
  });

  it('a mocked transaction delivering the wrong asset (not RLUSD) fails', async () => {
    const { res } = await settleWithTxHash({ deliveredCurrency: 'USD' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('settle_failed');
  });

  it('REPLAY PROTECTION: redeeming the same txHash twice — second attempt is rejected with already_redeemed', async () => {
    installFakeSettledTxsDb();
    const requestMock = mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const settleArgs = {
      selection: { chain: 'xrpl-testnet' as const, rail: 'x402' as const, asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: JSON.stringify({ txHash: TX_HASH }),
    };

    const first = await rail.settle(settleArgs);
    expect(first.ok).toBe(true);

    const second = await rail.settle(settleArgs);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('already_redeemed');

    // The replay check must short-circuit BEFORE re-verifying on-chain —
    // the RPC mock should only have been called once (for the first,
    // genuine attempt), not twice.
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('works identically on xrpl-mainnet (network resolution, not just testnet)', async () => {
    installFakeSettledTxsDb();
    mockXrplTxLookup({});
    const { createNPaymentRail } = await import('../src/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    const res = await rail.settle({
      selection: { chain: 'xrpl-mainnet', rail: 'x402', asset: 'RLUSD' },
      amount: '0.50', userId: 'u1', tier: 'confidential',
      proof: JSON.stringify({ txHash: TX_HASH }),
    });
    expect(res.ok).toBe(true);
  });
});

// ─── Tier 2: live testnet integration test (opt-in, real funds/network) ──

const RUN_LIVE = process.env.RUN_LIVE_XRPL_TESTS === 'true';
const DEMO_ENV_PATH = join(__dirname, '..', 'scripts', '.env.rlusd-demo');

describe.skipIf(!RUN_LIVE)('Tier 2 · LIVE testnet integration — real payment, real settlement, real replay rejection', () => {
  it('submits a real testnet Payment, settles it end-to-end via payments.settle, flips payments.status to active, and rejects replay', async () => {
    if (!existsSync(DEMO_ENV_PATH)) {
      throw new Error(`RUN_LIVE_XRPL_TESTS=true but ${DEMO_ENV_PATH} does not exist — cannot run the live test without RLUSD_DEMO_SEED.`);
    }
    const envContent = readFileSync(DEMO_ENV_PATH, 'utf8');
    const seedMatch = envContent.match(/^RLUSD_DEMO_SEED=(.+)$/m);
    if (!seedMatch) throw new Error(`${DEMO_ENV_PATH} exists but has no RLUSD_DEMO_SEED line.`);
    const seed = seedMatch[1].trim();

    // beforeEach() sets XRPL_TREASURY_ADDRESS to a fake mocked-test address
    // for the Tier 1 unit tests above — override it here to the real,
    // pre-confirmed RLUSD-trustlined testnet address the demo script
    // (scripts/demo-t54-rlusd-dream-cycle.ts) already uses by default, so
    // this live test pays a genuine, reachable destination.
    const treasury = 'rpoGVrMJHbpWa6XNrtDigDeXxG6j5cbHtC';
    const amount = '0.50'; // TIER_PRICE_USD.confidential — must match the real tier price

    // Wallet signing + real on-chain submission happens in a SEPARATE
    // process (scripts/xrpl-live-submit-helper.mjs) — see that file's own
    // header comment for why: n-payment's wallet key derivation
    // (ripple-keypairs -> @noble/curves) throws under this repo's default
    // Vitest jsdom environment, confirmed via a standalone script using the
    // exact same APIs succeeding outside Vitest. The settlement/verification
    // logic exercised below (RPC reads only, no wallet signing) does not
    // hit this conflict, so it runs inline as normal.
    const { execFileSync } = await import('node:child_process');
    const helperPath = join(__dirname, '..', 'scripts', 'xrpl-live-submit-helper.mjs');
    const raw = execFileSync('node', [helperPath, 'testnet', treasury, amount], {
      env: { ...process.env, RLUSD_DEMO_SEED: seed },
      encoding: 'utf8',
      timeout: 45_000,
    });
    const submitResult = JSON.parse(raw.trim().split('\n').pop() ?? '{}') as { ok: boolean; txHash?: string; payerAddress?: string; error?: string };
    if (!submitResult.ok || !submitResult.txHash) {
      throw new Error(`Real XRPL submission did NOT succeed: ${submitResult.error ?? 'unknown error'}`);
    }
    const txHash = submitResult.txHash;
    // eslint-disable-next-line no-console
    console.log(`[live xrpl settlement test] real testnet tx: https://testnet.xrpl.org/transactions/${txHash}`);

    process.env.XRPL_TREASURY_ADDRESS = treasury;
    // selectRail() (payment-router.ts) only chooses the REAL rail
    // (createNPaymentRail) over MockPaymentRail when
    // isRealPaymentsConfigured() sees BOTH MCP_FACILITATOR_PRIVATE_KEY and
    // PAY_TO_ADDRESS set — a check designed around the EVM rail, which is
    // irrelevant to XRPL settlement (settleXrplRlusd()/
    // settleXrplAlreadySubmitted() never read or use this key at all). Set
    // a syntactically-valid but otherwise-unused dummy key here so this test
    // genuinely exercises the real rail end-to-end through the full
    // payments.settle -> settleSelection -> selectRail -> createNPaymentRail
    // stack, rather than silently falling through to the deterministic mock
    // rail (which would make this test pass regardless of whether the real
    // replay-protection logic works at all).
    if (!process.env.MCP_FACILITATOR_PRIVATE_KEY) {
      process.env.MCP_FACILITATOR_PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';
    }
    const { settleSelection, findActiveSession } = await import('../src/lib/mcp/paywall');
    const userId = `live-xrpl-settlement-test-${Date.now()}`;

    const settled = await settleSelection(userId, 'confidential', { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' }, JSON.stringify({ txHash }));
    if (!settled.ok) console.error('[live xrpl settlement test] settle FAILED:', JSON.stringify(settled));
    expect(settled.ok).toBe(true);

    const status = await findActiveSession(userId, 'confidential');
    expect(status).not.toBeNull();
    expect(status?.quotaRemaining).toBeGreaterThan(0);

    const secondAttempt = await settleSelection(`${userId}-second`, 'confidential', { chain: 'xrpl-testnet', rail: 'x402', asset: 'RLUSD' }, JSON.stringify({ txHash }));
    expect(secondAttempt.ok).toBe(false);
    if (!secondAttempt.ok) expect(secondAttempt.error).toMatch(/already/i);
  }, 60_000);
});

// ─── Tier 3: mainnet smoke test (manual pre-release gate ONLY — never CI) ──
//
// MANUAL PRE-RELEASE CHECKLIST: before shipping any change to
// npayment-rails.ts's XRPL settlement path, run this once by hand:
//   RUN_LIVE_XRPL_MAINNET_TESTS=true RLUSD_DEMO_SEED=<mainnet-funded-seed> \
//     npx vitest run tests/mcp-xrpl-settlement.test.ts -t "Tier 3"
// Record the resulting real mainnet tx hash + settlement receipt in the
// release notes / PRD doc, mirroring this repo's existing published-testnet-
// tx-hash discipline (README.md's T54+XRPL section). This tier is NEVER
// executed automatically — no CI job, no default env, no exception.

const RUN_LIVE_MAINNET = process.env.RUN_LIVE_XRPL_MAINNET_TESTS === 'true';

describe.skipIf(!RUN_LIVE_MAINNET)('Tier 3 · MAINNET smoke test — manual pre-release gate only, real RLUSD spend', () => {
  it('submits a real minimal mainnet Payment and settles it end-to-end', async () => {
    if (!existsSync(DEMO_ENV_PATH)) {
      throw new Error(`RUN_LIVE_XRPL_MAINNET_TESTS=true but ${DEMO_ENV_PATH} does not exist.`);
    }
    const envContent = readFileSync(DEMO_ENV_PATH, 'utf8');
    const seedMatch = envContent.match(/^RLUSD_DEMO_SEED=(.+)$/m);
    if (!seedMatch) throw new Error(`${DEMO_ENV_PATH} exists but has no RLUSD_DEMO_SEED line.`);
    const seed = seedMatch[1].trim();

    const treasury = process.env.XRPL_TREASURY_ADDRESS;
    if (!treasury) throw new Error('XRPL_TREASURY_ADDRESS must be set for the mainnet smoke test.');
    const amount = '0.01'; // smallest possible amount — real RLUSD, real spend

    // See Tier 2's identical comment above — wallet signing happens in a
    // separate process to avoid the jsdom/@noble-curves conflict.
    const { execFileSync } = await import('node:child_process');
    const helperPath = join(__dirname, '..', 'scripts', 'xrpl-live-submit-helper.mjs');
    const raw = execFileSync('node', [helperPath, 'mainnet', treasury, amount], {
      env: { ...process.env, RLUSD_DEMO_SEED: seed },
      encoding: 'utf8',
      timeout: 45_000,
    });
    const submitResult = JSON.parse(raw.trim().split('\n').pop() ?? '{}') as { ok: boolean; txHash?: string; error?: string };
    if (!submitResult.ok || !submitResult.txHash) {
      throw new Error(`Real XRPL MAINNET submission did NOT succeed: ${submitResult.error ?? 'unknown error'}`);
    }
    const txHash = submitResult.txHash;
    // eslint-disable-next-line no-console
    console.log(`[MAINNET smoke test] real mainnet tx: https://livenet.xrpl.org/transactions/${txHash} — RECORD THIS IN RELEASE NOTES`);

    // See Tier 2's identical comment above re: isRealPaymentsConfigured().
    if (!process.env.MCP_FACILITATOR_PRIVATE_KEY) {
      process.env.MCP_FACILITATOR_PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';
    }
    const { settleSelection } = await import('../src/lib/mcp/paywall');
    const settled = await settleSelection(`mainnet-smoke-${Date.now()}`, 'confidential', { chain: 'xrpl-mainnet', rail: 'x402', asset: 'RLUSD' }, JSON.stringify({ txHash }));
    expect(settled.ok).toBe(true);
  }, 60_000);
});
