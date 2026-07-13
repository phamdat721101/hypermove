/**
 * tests/mcp-gateway.test.ts
 * -------------------------
 * Mock-first, DB-optional verification for the MCP Gateway v1.0. No DATABASE_URL
 * is set, so withClient() returns null everywhere and every module exercises its
 * mock/dev path — proving the gateway works zero-config.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { ok, fail, softEmpty, guardEnvelope } from '@/lib/mcp/envelope';
import { MockProvider } from '@/lib/mcp/providers/mock';
import { AdapterRouter, decide } from '@/lib/mcp/providers/router';
import { getCatalog, _resetCatalog } from '@/lib/mcp/catalog';
import { lexicalSearch } from '@/lib/mcp/search';
import { MockEmbedder } from '@/lib/mcp/embeddings';
import { MemoryVectorStore, cosine } from '@/lib/mcp/vector-store';
import { supportedNetworks, validateSelection, MockPaymentRail, _resetNetworks } from '@/lib/mcp/payment-router';
import { buildChallenge, TIER_PRICE_USD } from '@/lib/mcp/paywall';
import { newsSearch, newsInsight, _resetNews } from '@/lib/mcp/news';
import { getTool, getTools, _resetTools } from '@/lib/mcp/tools';

beforeEach(() => {
  _resetCatalog();
  _resetNetworks();
  _resetNews();
  _resetTools();
  delete process.env.DATABASE_URL; // hermetic: exercise mock-first / DB-optional paths
  process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
  process.env.FEATURE_MCP_VECTOR_SEARCH = 'true';
  process.env.FEATURE_MCP_NEWS_V1 = 'true';
});

// ── Task 1: envelope ────────────────────────────────────────────────────────
describe('envelope contract', () => {
  it('constructs ok / fail / soft-empty', () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 });
    expect(fail('svc', 'boom').error.kind).toBe('error');
    expect(softEmpty('svc', 'none').error.kind).toBe('soft-empty');
  });

  it('guard prelude throws on wrong-level payload access', () => {
    const env = guardEnvelope(ok({ projects: [1, 2] }));
    expect((env as { ok: true; data: { projects: number[] } }).data.projects).toEqual([1, 2]);
    // @ts-expect-error intentional wrong-level access
    expect(() => env.projects).toThrow(/data\.projects/);
  });
});

// ── Task 2: providers + router ────────────────────────────────────────────────
describe('provider router', () => {
  it('routes by chain/method', () => {
    expect(decide('getTokenBalances', 'solana-mainnet').primary).toBe('moralis');
    expect(decide('getContractState', 'base-mainnet').primary).toBe('alchemy');
    expect(decide('streamEvents', 'base-mainnet').primary).toBe('quicknode');
  });

  it('mock provider returns deterministic envelopes', async () => {
    const p = new MockProvider();
    const a = await p.call({ method: 'getTokenBalances', chain: 'base-mainnet', params: { address: '0xabc' } });
    const b = await p.call({ method: 'getTokenBalances', chain: 'base-mainnet', params: { address: '0xabc' } });
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });

  it('router falls back to mock', async () => {
    const router = new AdapterRouter([new MockProvider()]);
    const res = await router.dispatch({ method: 'getBlock', chain: 'base-mainnet', params: {} });
    expect(res.ok).toBe(true);
  });
});

// ── Task 4: catalog determinism ───────────────────────────────────────────────
describe('catalog', () => {
  it('is deterministic + sorted by id', () => {
    const a = getCatalog().map((e) => e.id);
    _resetCatalog();
    const b = getCatalog().map((e) => e.id);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
    expect(a.length).toBeGreaterThan(10);
  });
});

// ── Task 5: lexical search ────────────────────────────────────────────────────
describe('lexical search', () => {
  it('ranks token-balance query with operation hits', () => {
    const res = lexicalSearch(getCatalog(), { query: 'token balances', limit: 5 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].tier).toBe('lexical');
    expect(res.nextSteps).toContain('.data');
  });

  it('unknown service filter → zero hits + valid-options hint (no silent empty)', () => {
    const res = lexicalSearch(getCatalog(), { query: 'block', service: 'bogus' });
    expect(res.hits).toHaveLength(0);
    expect(res.nextSteps).toContain('moralis');
  });
});

// ── Task 6: embeddings + vector store ─────────────────────────────────────────
describe('embeddings + vector store', () => {
  it('MockEmbedder is deterministic + normalized', async () => {
    const e = new MockEmbedder();
    const v1 = await e.embed('base restaking');
    const v2 = await e.embed('base restaking');
    expect(v1).toEqual(v2);
    expect(cosine(v1, v1)).toBeCloseTo(1, 5);
  });

  it('MemoryVectorStore orders by cosine', async () => {
    const e = new MockEmbedder();
    const store = new MemoryVectorStore<string>();
    store.upsert([
      { id: 'a', embedding: await e.embed('token price feed'), meta: 'a' },
      { id: 'b', embedding: await e.embed('nft holdings wallet'), meta: 'b' },
    ]);
    const top = store.query(await e.embed('token price'), 1);
    expect(top[0].id).toBe('a');
  });
});

// ── Task 7: hybrid search via tool ────────────────────────────────────────────
describe('hybrid search tool', () => {
  it('search returns hits and vector.search returns semantic hits', async () => {
    const search = getTool('search')!;
    const res = (await search.handler({ query: 'gas price', limit: 5 })) as { hits: unknown[] };
    expect(res.hits.length).toBeGreaterThan(0);

    const vs = getTool('codemode.vector.search')!;
    const vres = (await vs.handler({ query: 'wallet token balance', k: 3 })) as { hits: unknown[] };
    expect(vres.hits.length).toBe(3);
  });
});

// ── Task 8/9: news layer ──────────────────────────────────────────────────────
describe('news layer', () => {
  it('news.search returns ranked daily items', async () => {
    const res = await newsSearch({ query: 'daily update', limit: 5 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.nextSteps).toContain('insight');
  });

  it('news.insight synthesizes a deterministic insight (mock)', async () => {
    const a = await newsInsight('x402');
    expect(a.project).toBe('x402');
    expect(typeof a.insight).toBe('string');
    expect(a.insight.length).toBeGreaterThan(0);
  });
});

// ── Task 12: multi-chain payment selection ────────────────────────────────────
describe('payment routing', () => {
  it('supported networks derive from registry', () => {
    const nets = supportedNetworks();
    expect(nets.length).toBeGreaterThan(0);
    expect(nets.every((n) => n.rails.length > 0)).toBe(true);
  });

  it('validates a good selection and rejects an unknown network', () => {
    const good = validateSelection({ chain: supportedNetworks()[0].chain });
    expect(good.ok).toBe(true);
    const bad = validateSelection({ chain: 'nope-chain' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.hint).toContain(supportedNetworks()[0].chain);
  });

  it('mock rail settles deterministically', async () => {
    const rail = new MockPaymentRail('x402');
    const sel = { chain: 'base-mainnet', rail: 'x402' as const, asset: 'USDC' };
    const a = await rail.settle({ selection: sel, amount: '0.01', userId: 'u1', proof: 'p' });
    const b = await rail.settle({ selection: sel, amount: '0.01', userId: 'u1', proof: 'p' });
    expect(a).toEqual(b);
  });

  it('402 challenge advertises tiers + all four rails (EVM-USDC / XRPL-RLUSD / GOAT-USDC / Stellar-USDC)', () => {
    const c = buildChallenge('t1_read', 3)['x-payment-required'];
    expect(c.amount).toBe(TIER_PRICE_USD.t1_read);
    expect(c.chains.length).toBeGreaterThan(0);
    expect(c.select_via_headers).toContain('X-Payment-Chain');
    // All four rails' chains are advertised.
    expect(c.chains).toContain('goat-mainnet');
    expect(c.chains).toContain('xrpl-mainnet');
    expect(c.chains).toContain('stellar-mainnet');
    expect(c.chains.some((ch) => ch.startsWith('base'))).toBe(true);
    // Assets cover USDC (EVM/GOAT/Stellar) + RLUSD (XRPL).
    expect(c.assets).toContain('USDC');
    expect(c.assets).toContain('RLUSD');
    // Both rails are offered via facilitators.
    expect(c.facilitators.x402).toBeTruthy();
    expect(c.facilitators.mpp).toBeTruthy();
  });

  it('GOAT-USDC + Stellar-USDC settlement fails honestly (not-live) via the real rail', async () => {
    const { createNPaymentRail } = await import('@/lib/mcp/npayment-rails');
    const rail = createNPaymentRail('x402');
    for (const chain of ['goat-mainnet', 'stellar-mainnet']) {
      const res = await rail.settle({ selection: { chain, rail: 'x402', asset: 'USDC' }, amount: '0.001', userId: 'u', proof: 'p' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(['unsupported_chain', 'no_proof', 'not_configured', 'settle_failed']).toContain(res.error.code);
        expect(res.error.hint).toBeTruthy(); // honest, actionable hint (never a fabricated receipt)
      }
    }
  });
});

// ── Task 14: discovery ────────────────────────────────────────────────────────
describe('discovery tools', () => {
  it('payments.networks lists networks + tiers', async () => {
    const res = (await getTool('codemode.payments.networks')!.handler({})) as { networks: unknown[]; tiers: unknown };
    expect(res.networks.length).toBeGreaterThan(0);
    expect(res.tiers).toBeTruthy();
  });

  it('spec exposes all enabled tools', async () => {
    const spec = (await getTool('codemode.spec')!.handler({})) as { paths: Record<string, unknown> };
    const names = getTools().map((t) => `/${t.name}`);
    for (const n of names) expect(spec.paths[n]).toBeTruthy();
  });

  it('describe returns entry or not_found hint', async () => {
    const first = getCatalog()[0].id;
    const hit = await getTool('codemode.describe')!.handler({ id: first });
    expect((hit as { id: string }).id).toBe(first);
    const miss = await getTool('codemode.describe')!.handler({ id: 'zzz.nope' });
    expect((miss as { error?: string }).error).toBe('not_found');
  });
});
