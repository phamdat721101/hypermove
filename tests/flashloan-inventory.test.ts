// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import pairs from './fixtures/flashloan-aixbt-token-pairs.json';
import batch from './fixtures/flashloan-aixbt-batch.json';
import { DexScreener, RequestBudget, inventorySchema } from '../src/lib/mcp/flashloan/discovery';
import { operationSchemas } from '../src/lib/mcp/flashloan/contracts';
import { publicSchemas } from '../src/lib/mcp/flashloan/public-contracts';
import { coinType } from '../src/lib/mcp/flashloan/networks';
const token = '0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825';
const input = operationSchemas.flashloan_discover_arbitrage_pools.parse({ network: 'base', tokens: [token], idempotency_key: 'test' });
const response = (raw: unknown) => new Response(JSON.stringify(raw));
const client = (raw: unknown) => new DexScreener(vi.fn(async () => response(raw)), new RequestBudget(0));
describe('v2 pool inventory', () => {
  it('reproduces and fixes the AIXBT batch-1 versus token-pairs-19 defect', async () => {
    expect(batch).toHaveLength(1); expect(pairs).toHaveLength(19);
    const fetcher = vi.fn(async (url: string | URL | Request) => response(String(url).includes('/token-pairs/') ? pairs : batch));
    const result = await new DexScreener(fetcher, new RequestBudget(0)).discover(input);
    expect(inventorySchema.safeParse(result).success).toBe(true);
    expect(result.pools).toHaveLength(19);
    expect(result.token_results[0]).toMatchObject({ discovered_count: 19, liquidity_eligible_count: 3, route_status: 'NOT_EVALUATED' });
    expect(result.pools.filter((p) => p.labels.includes('v4'))).toHaveLength(2);
    expect(result.pools.filter((p) => p.labels.includes('v4')).every((p) => p.reference.kind === 'provider_opaque')).toBe(true);
    expect(result.coverage[0]).toMatchObject({ retrieval_complete: true, exhaustive: false, raw_count: 19 });
    expect(result).not.toHaveProperty('complete'); expect(result).not.toHaveProperty('rejected');
    expect(fetcher.mock.calls[0][0]).toContain('/token-pairs/v1/base/');
  });
  it('retains missing and zero liquidity, and never requires two pools for listing', async () => {
    const raw = [{ ...pairs[0], liquidity: null }, { ...pairs[1], liquidity: { usd: 0 } }];
    const result = await client(raw).discover(input);
    expect(result.pools).toHaveLength(2);
    expect(result.pools.map((p) => p.liquidity_eligible).sort()).toEqual([false, null]);
    expect(result.token_results[0].liquidity_eligible_count).toBe(0);
    expect((await client([pairs[0]]).discover(input)).pools).toHaveLength(1);
  });
  it('normalizes EVM identity and deduplicates repeated tokens and provider rows', async () => {
    const result = await client([pairs[0], { ...pairs[0], pairAddress: pairs[0].pairAddress.toLowerCase() }]).discover({ ...input, tokens: [token, token.toLowerCase()] });
    expect(result.pools).toHaveLength(1); expect(result.token_results).toHaveLength(1);
  });
  it('diagnoses malformed, wrong-chain and unrelated rows instead of claiming exhaustive success', async () => {
    const result = await client([{}, { ...pairs[0], chainId: 'ethereum' }, { ...pairs[0], baseToken: { address: '0x' + '1'.repeat(40) } }, pairs[0]]).discover(input);
    expect(result.pools).toHaveLength(1); expect(result.outcome).toBe('PARTIAL');
    expect(result.diagnostics.map((d) => d.code)).toEqual(['MALFORMED_PROVIDER_RECORD', 'WRONG_CHAIN', 'UNRELATED_PAIR']);
  });
  it('distinguishes empty, partial source failure, total failure and excluded inputs', async () => {
    expect((await client([]).discover(input)).outcome).toBe('EMPTY');
    const excluded = await client(pairs).discover({ ...input, exclude_tokens: [token] });
    expect(excluded.coverage).toEqual([]); expect(excluded.token_results[0].disposition).toBe('EXCLUDED');
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes(token.toLowerCase()) ? response(pairs) : new Response('', { status: 400 }));
    const dex = new DexScreener(fetcher, new RequestBudget(0));
    expect((await dex.discover({ ...input, tokens: [token.toLowerCase(), '0x' + '1'.repeat(40)] })).outcome).toBe('PARTIAL');
    await expect(dex.discover({ ...input, tokens: ['0x' + '1'.repeat(40)] })).rejects.toMatchObject({ code: 'DISCOVERY_UNAVAILABLE' });
  });
  it('does not report excluded quote tokens as included inventory targets', async () => {
    const quote = pairs[0].quoteToken.address;
    const result = await client([pairs[0]]).discover({ ...input, tokens: [token, quote], exclude_tokens: [quote] });
    expect(result.pools).toHaveLength(1);
    expect(result.token_results.find((r) => r.disposition === 'EXCLUDED')).toMatchObject({ discovered_count: 0, liquidity_eligible_count: 0, pool_ids: [] });
  });
  it('validates identifiers according to network in private and public schemas', () => {
    for (const schema of [operationSchemas.flashloan_discover_arbitrage_pools, publicSchemas.flashloan_discover_arbitrage_pools]) {
      const base = schema === operationSchemas.flashloan_discover_arbitrage_pools ? { idempotency_key: 'test' } : {};
      expect(schema.safeParse({ ...base, network: 'sui', tokens: ['0x2::sui::SUI'] }).success).toBe(true);
      expect(schema.safeParse({ ...base, network: 'sui', tokens: [token] }).success).toBe(false);
      expect(schema.safeParse({ ...base, network: 'base', tokens: ['0x2::sui::SUI'] }).success).toBe(false);
      expect(schema.safeParse({ ...base, network: 'base', tokens: [token], extra: true }).success).toBe(false);
    }
    expect(coinType.parse('0x2::sui::SUI')).toContain('::sui::SUI');
    expect(coinType.safeParse('0x2::sui::SUI garbage').success).toBe(false);
  });
  it('keeps Sui object IDs and Move coin types separate', async () => {
    const raw = [{ ...pairs[0], chainId: 'sui', pairAddress: '0x' + 'a'.repeat(64), baseToken: { address: '0x2::sui::SUI' }, quoteToken: { address: '0x3::usdc::USDC' } }];
    const result = await client(raw).discover({ ...input, network: 'sui', tokens: ['0x2::sui::SUI'] });
    expect(result.pools[0].reference.kind).toBe('sui_object');
    expect(result.pools[0].asset_ids[0]).toContain('::sui::SUI');
  });
});
