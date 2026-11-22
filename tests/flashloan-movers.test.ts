// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DexScreener, RequestBudget } from '../src/lib/mcp/flashloan/discovery';
import { getTokenMovers, moverInputSchema, moversResultSchema } from '../src/lib/mcp/flashloan/movers';
import { publicSchemas } from '../src/lib/mcp/flashloan/public-contracts';
import { operationSchemas } from '../src/lib/mcp/flashloan/contracts';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), Q = '0x' + '1'.repeat(40);
const sui = '0x2::sui::SUI', quoteSui = '0x3::usdc::USDC';
const market = (token = A, change: number | null = 10, extra: Record<string, unknown> = {}) => ({ chainId: 'base', dexId: 'fixture', pairAddress: 'pool-' + token, baseToken: { address: token, symbol: 'TOKEN' }, quoteToken: { address: Q }, priceUsd: '1.25', liquidity: { usd: 15000 }, volume: { h24: 100 }, priceChange: { h24: change }, pairCreatedAt: Date.now() - 2 * 86400000, ...extra });
function provider(rows: unknown[], extra?: (url: string, init?: RequestInit) => Promise<Response | undefined> | undefined) {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => (await extra?.(String(url), init)) ?? Response.json(String(url).includes('/tokens/v1/') ? rows : String(url).includes('/search?') ? { pairs: [] } : []));
  return { fetcher, dex: new DexScreener(fetcher, new RequestBudget(0), new RequestBudget(0)) };
}
const input = (extra: Record<string, unknown> = {}) => moverInputSchema.parse({ networks: ['base'], seed_tokens: { base: [A, B] }, ...extra });
afterEach(() => { vi.useRealTimers(); });

describe('token mover contracts and ranking', () => {
  it('defaults to all four networks and rejects unknown fields, duplicates and wrong-family seeds', () => {
    expect(moverInputSchema.parse({}).networks).toEqual(['base', 'arbitrum', 'robinhood', 'sui']);
    for (const value of [{ networks: [] }, { networks: ['base', 'base'] }, { direction: 'up' }, { min_change_24h_pct: 9 }, { limit_per_chain: 11 }, { min_liquidity_usd: Infinity }, { extra: true }, { networks: ['base'], seed_tokens: { sui: [sui] } }, { seed_tokens: { base: [sui] } }, { seed_tokens: { sui: [A] } }]) expect(moverInputSchema.safeParse(value).success).toBe(false);
    expect(publicSchemas.flashloan_get_token_movers.safeParse({}).success).toBe(true);
    expect(operationSchemas).not.toHaveProperty('flashloan_get_token_movers');
  });
  it.each(['both', 'gainers', 'losers'])('uses inclusive ±10 boundaries in %s mode', async (direction) => {
    const { dex } = provider([market(A, 10), market(B, -10)]);
    const result = await getTokenMovers(dex, input({ direction }));
    const tokens = result.chains[0].tokens;
    expect(tokens.map((t) => t.price_change_24h_pct)).toEqual(direction === 'both' ? [10, -10] : direction === 'gainers' ? [10] : [-10]);
    expect(result.chains[0].outcome).toBe('SUCCESS');
    expect(moversResultSchema.safeParse(result).success).toBe(true);
    expect(tokens[0].representative_market.provider_updated_at).toBeNull();
  });
  it('excludes changes just below the threshold, preserves single-pool tokens and never pads', async () => {
    const { dex } = provider([market(A, 9.999), market(B, -9.999)]);
    const result = await getTokenMovers(dex, input());
    expect(result.chains[0]).toMatchObject({ outcome: 'EMPTY', tokens: [], coverage: { eligible_count: 2, matched_count: 0 } });
  });
  it('selects the deepest market before applying the threshold and never falls back for missing change', async () => {
    const { dex } = provider([market(A, 80), market(A, 1, { pairAddress: 'deep', liquidity: { usd: 50000 } }), market(B, 80), market(B, null, { pairAddress: 'deep-b', liquidity: { usd: 50000 } })]);
    const result = await getTokenMovers(dex, input());
    expect(result.chains[0].tokens).toEqual([]);
    expect(result.chains[0].coverage.excluded_counts).toMatchObject({ BELOW_CHANGE_THRESHOLD: 1, MISSING_24H_CHANGE: 1 });
  });
  it('ties representatives by volume then pool ID and tokens by identity', async () => {
    const { dex } = provider([market(A, 20, { pairAddress: 'z' }), market(A, 30, { pairAddress: 'b', volume: { h24: 200 } }), market(A, 40, { pairAddress: 'a', volume: { h24: 200 } }), market(B, -40, { volume: { h24: 200 } })]);
    const result = await getTokenMovers(dex, input());
    expect(result.chains[0].tokens.map((t) => t.token_id)).toEqual([A, B]);
    expect(result.chains[0].tokens[0].representative_market.provider_pair_id).toBe('a');
    expect(result.chains[0].tokens.map((t) => t.rank)).toEqual([1, 2]);
  });
  it('never promotes a smaller pool when the primary market has an invalid change', async () => {
    const result = await getTokenMovers(provider([market(A, 90), market(A, 20, { pairAddress: 'deep', liquidity: { usd: 50000 }, priceChange: { h24: 'bad' } })]).dex, input());
    expect(result.chains[0].tokens).toEqual([]);
    expect(result.chains[0].coverage.excluded_counts.INVALID_24H_CHANGE).toBe(1);
  });
  it('normalizes invalid optional metadata without promoting a smaller market', async () => {
    const result = await getTokenMovers(provider([market(A, 90), market(A, 1, { pairAddress: 'deep', liquidity: { usd: 50000 }, volume: { h24: 'bad' }, baseToken: { address: A, name: {}, symbol: 7 } })]).dex, input());
    expect(result.chains[0].tokens).toEqual([]);
    expect(result.chains[0].diagnostics.some((d) => d.code === 'INVALID_VOLUME')).toBe(true);
  });
  it('never accepts a scalar priceChange as the h24 metric', async () => {
    const result = await getTokenMovers(provider([market(A, 90), market(A, 20, { pairAddress: 'deep', liquidity: { usd: 50000 }, priceChange: 50 })]).dex, input());
    expect(result.chains[0].tokens).toEqual([]);
    expect(result.chains[0].coverage.excluded_counts.INVALID_24H_CHANGE).toBe(1);
  });
  it('rejects conflicting identities for one provider pool, including earlier observations', async () => {
    const result = await getTokenMovers(provider([market(A, 90, { pairAddress: 'same' }), market(B, 80, { pairAddress: 'same' }), market(A, 90, { pairAddress: 'same' })]).dex, input());
    expect(result.chains[0].tokens).toEqual([]);
    expect(result.chains[0].diagnostics.some((d) => d.code === 'CONFLICTING_POOL_ID')).toBe(true);
  });
  it('discloses malformed feed records instead of claiming a healthy empty scan', async () => {
    const { dex } = provider([], async (url) => url.includes('/token-profiles/') ? Response.json([{}, { chainId: 1 }]) : undefined);
    const result = await getTokenMovers(dex, input({ seed_tokens: {} }));
    expect(result.chains[0].outcome).toBe('PARTIAL');
    expect(result.chains[0].diagnostics[0].code).toBe('MALFORMED_PROVIDER_RECORD');
  });
  it.each([{ liquidity: { usd: 14999 } }, { liquidity: null }, { priceUsd: '0' }, { priceUsd: 'Infinity' }, { pairCreatedAt: null }, { pairCreatedAt: Date.now() + 100000 }, { pairCreatedAt: Date.now() - 1000 }])('excludes ineligible market metadata %j', async (extra) => {
    const result = await getTokenMovers(provider([market(A, 20, extra)]).dex, input());
    expect(result.chains[0].tokens).toEqual([]);
  });
  it('does not use quote-only changes, wrong chains or malformed identifiers', async () => {
    const result = await getTokenMovers(provider([market(Q, 90, { quoteToken: { address: A } }), market(A, 99, { chainId: 'arbitrum' }), market(A, 99, { quoteToken: { address: 'invalid' } }), {}]).dex, input());
    expect(result.chains[0]).toMatchObject({ outcome: 'PARTIAL', tokens: [] });
    expect(result.chains[0].diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['WRONG_CHAIN', 'MALFORMED_ASSET_ID', 'MALFORMED_PROVIDER_RECORD']));
  });
  it('normalizes EVM seeds and preserves case-sensitive Sui type identifiers', async () => {
    const { dex } = provider([market(A, 25), market(sui, -30, { chainId: 'sui', quoteToken: { address: quoteSui } })]);
    const result = await getTokenMovers(dex, moverInputSchema.parse({ networks: ['base', 'sui'], seed_tokens: { base: [A.toUpperCase().replace('0X', '0x'), A], sui: [sui] } }));
    expect(result.chains[0].coverage.candidate_count).toBe(1);
    expect(result.chains[1].tokens[0].token_id).toMatch(/::sui::SUI$/);
    expect(result.chains[1].tokens[0].representative_market.quote_token_id).toMatch(/::usdc::USDC$/);
    expect(result.chains[1].chain_id).toBeNull();
  });
  it('caps 60 candidates, batches at 30, prioritizes callers and discloses truncation', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
    const { dex, fetcher } = provider([], async (url) => url.includes('/token-profiles/') ? Response.json(ids.map((tokenAddress) => ({ chainId: 'base', tokenAddress }))) : undefined);
    const result = await getTokenMovers(dex, input());
    const batches = fetcher.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/tokens/v1/'));
    expect(batches).toHaveLength(2);
    expect(batches.every((url) => url.split('/').pop()!.split(',').length === 30)).toBe(true);
    expect(batches[0]).toContain(A);
    expect(result.chains[0]).toMatchObject({ outcome: 'PARTIAL', coverage: { candidate_count: 82, scanned_count: 60, truncated_candidate_count: 22, exhaustive: false } });
  });
  it('returns EMPTY for healthy empty discovery and UNAVAILABLE for failed metric requests', async () => {
    expect((await getTokenMovers(provider([]).dex, input({ seed_tokens: {} }))).chains[0].outcome).toBe('EMPTY');
    const unavailable = provider([], async (url) => url.includes('/tokens/v1/') ? new Response('', { status: 403 }) : undefined);
    const result = await getTokenMovers(unavailable.dex, input());
    expect(result.chains[0].outcome).toBe('UNAVAILABLE');
    expect(result.chains[0].coverage.scanned_count).toBe(0);
    expect(unavailable.fetcher.mock.calls.filter(([url]) => String(url).includes('/tokens/v1/'))).toHaveLength(1);
  });
  it('keeps valid data when a discovery source fails and bounds diagnostics', async () => {
    const { dex } = provider([market(A, 20), ...Array(100).fill({})], async (url) => url.includes('/token-profiles/') ? new Response('', { status: 400 }) : undefined);
    const result = await getTokenMovers(dex, input());
    expect(result.chains[0].outcome).toBe('PARTIAL');
    expect(result.chains[0].tokens).toHaveLength(1);
    expect(result.chains[0].diagnostics).toHaveLength(64);
  });
  it('retries transient requests once, honoring Retry-After', async () => {
    vi.useFakeTimers(); let tries = 0;
    const { dex } = provider([market()], async (url) => url.includes('/tokens/v1/') && tries++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : undefined);
    const pending = getTokenMovers(dex, input());
    await vi.advanceTimersByTimeAsync(1001);
    const result = await pending;
    expect(tries).toBe(2);
    expect(result.chains[0].coverage.source_results.at(-1)?.attempts).toBe(2);
    expect(result.chains[0].tokens).toHaveLength(1);
  });
  it('returns completed-chain data when another chain stalls beyond the scan budget', async () => {
    vi.useFakeTimers();
    const { dex } = provider([market()], async (url, init) => url.includes('/tokens/v1/arbitrum/') ? new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) : undefined);
    const pending = getTokenMovers(dex, moverInputSchema.parse({ networks: ['base', 'arbitrum'], seed_tokens: { base: [A], arbitrum: [A] } }), undefined, 100);
    await vi.advanceTimersByTimeAsync(101);
    const result = await pending;
    expect(result.chains[0].tokens).toHaveLength(1);
    expect(result.chains[1].outcome).toBe('UNAVAILABLE');
    expect(result.chains[1].diagnostics[0].code).toBe('SCAN_BUDGET_EXPIRED');
  });
  it('retries a stalled response body as a dependency timeout, not caller cancellation', async () => {
    vi.useFakeTimers(); let tries = 0, cancelled = false;
    const { dex } = provider([market()], async (url) => url.includes('/tokens/v1/') && tries++ === 0 ? new Response(new ReadableStream({ cancel() { cancelled = true; } })) : undefined);
    const pending = getTokenMovers(dex, input());
    await vi.advanceTimersByTimeAsync(5251);
    const result = await pending;
    expect(cancelled).toBe(true); expect(tries).toBe(2);
    expect(result.chains[0].tokens).toHaveLength(1);
    expect(result.chains[0].coverage.source_results.at(-1)?.attempts).toBe(2);
  });
  it.each(['999999999', 'Wed, 01 Jan 2098 00:00:00 GMT'])('rejects Retry-After outside the scan budget: %s', async (header) => {
    const { dex, fetcher } = provider([], async (url) => url.includes('/tokens/v1/') ? new Response('', { status: 429, headers: { 'retry-after': header } }) : undefined);
    const result = await getTokenMovers(dex, input());
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/tokens/v1/'))).toHaveLength(1);
    expect(result.chains[0].diagnostics.some((d) => d.code === 'SCAN_BUDGET_EXPIRED')).toBe(true);
  });
  it('limits ranked output to ten and reports all matches', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
    const result = await getTokenMovers(provider(ids.map((id, i) => market(id, i + 10))).dex, input({ seed_tokens: { base: ids } }));
    expect(result.chains[0].tokens).toHaveLength(10);
    expect(result.chains[0].coverage.matched_count).toBe(20);
    expect(result.chains[0].tokens[0].price_change_24h_pct).toBe(29);
  });
  it('caps attempts at 24 and concurrent requests at three under transient failures', async () => {
    vi.useFakeTimers(); let active = 0, peak = 0;
    const fetcher = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1)); active--;
      return new Response('', { status: 503 });
    });
    const dex = new DexScreener(fetcher, new RequestBudget(0), new RequestBudget(0));
    const pending = getTokenMovers(dex, moverInputSchema.parse({ seed_tokens: { base: [A], arbitrum: [A], robinhood: [A], sui: [sui] } }));
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(fetcher).toHaveBeenCalledTimes(24); expect(peak).toBeLessThanOrEqual(3);
    expect(result.chains.every((chain) => chain.outcome === 'UNAVAILABLE')).toBe(true);
  });
  it('aborts in-flight requests when the caller disconnects', async () => {
    const controller = new AbortController(); let observed = false;
    const { dex } = provider([], async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { observed = true; reject(new Error('aborted')); }, { once: true });
      queueMicrotask(() => controller.abort());
    }));
    await expect(getTokenMovers(dex, input(), controller.signal)).rejects.toThrow();
    expect(observed).toBe(true);
  });
  it('rejects oversized provider bodies without retrying', async () => {
    const { dex, fetcher } = provider([], async (url) => url.includes('/tokens/v1/') ? new Response(' '.repeat(4000001)) : undefined);
    const result = await getTokenMovers(dex, input());
    expect(result.chains[0].diagnostics.some((d) => d.code === 'RESPONSE_TOO_LARGE')).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/tokens/v1/'))).toHaveLength(1);
  });
  it('propagates caller cancellation rather than publishing partial output', async () => {
    const controller = new AbortController(); controller.abort();
    const { dex, fetcher } = provider([]);
    await expect(getTokenMovers(dex, input(), controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe.runIf(process.env.FLASHLOAN_MOVERS_LIVE === '1')('live bounded DexScreener scan', () => {
  it('validates all four networks without requiring ten current matches', async () => {
    const result = await getTokenMovers(new DexScreener(), moverInputSchema.parse({}));
    expect(moversResultSchema.safeParse(result).success).toBe(true);
    expect(result.chains).toHaveLength(4);
    for (const chain of result.chains) {
      expect(chain.coverage.exhaustive).toBe(false);
      expect(chain.tokens.length).toBeLessThanOrEqual(10);
      for (const token of chain.tokens) expect(Math.abs(token.price_change_24h_pct)).toBeGreaterThanOrEqual(10);
    }
    expect(result.chains.some((chain) => chain.coverage.source_results.some((source) => source.status === 'SUCCESS'))).toBe(true);
    console.log(JSON.stringify({ event: 'flashloan.movers_live', chains: result.chains.map((chain) => ({ network: chain.network, outcome: chain.outcome, returned: chain.tokens.length, scanned: chain.coverage.scanned_count })) }));
  }, 30000);
});
