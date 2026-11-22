// @vitest-environment node
// EDGE-01 (seam: discovery) for docs/features/flashloan-mcp-arb-upgrade-map.md.
// D1: an exhausted round budget made the final canonicality check fail and erased every pool.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchEngine } from '../src/lib/mcp/flashloan/engine';
import { inventoryV3Schema } from '../src/lib/mcp/flashloan/v8-contracts';
import { RoundBudget } from '../src/lib/mcp/flashloan/transport';
import { ResearchError } from '../src/lib/mcp/flashloan/contracts';
import { fixtureV8, A8, BLOCK8 } from './fixtures/flashloan-v8';
import { readFileSync } from 'node:fs';
import { keccak256, type Hex } from 'viem';
import { DiscoveryRegistry, discoveryRegistryConfigSchema } from '../src/lib/mcp/flashloan/discovery-registry';

afterEach(() => { vi.restoreAllMocks(); });
const engine = (options: Parameters<typeof fixtureV8>[0] = {}) => { const fixture = fixtureV8(options); return { ...fixture, engine: new ResearchEngine({ endpoints: { [fixture.network]: 'https://rpc.test' }, deployments: [], discoveryRegistry: fixture.registry, fetcher: fixture.fetcher }) }; };
const marker = () => console.log(JSON.stringify({ event: 'flashloan.arb.edge', marker: 'FLARB_EDGE_01', passed: true }));
const budget = (maxRpcCalls: number, deadlineMs = 60_000) => new RoundBudget({ maxRpcCalls, maxEvaluations: 0, deadlineMs }, new AbortController().signal);

describe('final verification reservation (RoundBudget.reserveFinal)', () => {
  it('holds calls back from ordinary work and releases them only to the guarded step', async () => {
    const b = budget(5); const lease = b.reserveFinal(2, 10);
    for (let i = 0; i < 3; i++) b.rpc();
    expect(() => b.rpc()).toThrow(ResearchError); // ordinary work is exhausted at max - reserved
    const calls = await lease.run(async () => { b.rpc(); b.rpc(); return b.rpcCallsUsed; });
    expect(calls).toBe(5); // the reserved two were available to the final check
    expect(() => b.rpc()).toThrow(ResearchError);
    await expect(lease.run(async () => 1)).rejects.toThrow(ResearchError); // single use
    b.dispose();
  });
  it('reserves time and returns everything when the guarded step is never reached', () => {
    const b = budget(10, 10_000); const before = b.remainingMs();
    const lease = b.reserveFinal(3, 4_000);
    expect(b.remainingMs()).toBeLessThanOrEqual(before - 4_000 + 5);
    lease.release(); lease.release(); // idempotent
    expect(b.remainingMs()).toBeGreaterThan(before - 50);
    for (let i = 0; i < 10; i++) b.rpc();
    expect(() => b.rpc()).toThrow(ResearchError);
    b.dispose();
  });
  it('keeps one lease per pending verification so a later network is not starved', async () => {
    const b = budget(6); const first = b.reserveFinal(2, 1), second = b.reserveFinal(2, 1);
    b.rpc(); b.rpc();
    expect(() => b.rpc()).toThrow(ResearchError);
    await first.run(async () => { b.rpc(); b.rpc(); });
    await second.run(async () => { b.rpc(); b.rpc(); });
    expect(b.rpcCallsUsed).toBe(6);
    b.dispose();
  });
  it('rejects malformed reservations', () => {
    const b = budget(5);
    expect(() => b.reserveFinal(0, 1)).toThrow(ResearchError);
    expect(() => b.reserveFinal(1, 0)).toThrow(ResearchError);
    b.dispose();
  });
});

describe('inventory final check outcomes', () => {
  it('retains verified reads and reports PARTIAL when the final check is unavailable (D1 regression)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { engine: e } = engine({ fault: 'final-unavailable' });
    const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.block?.hash).toBe(BLOCK8);
    expect(result.pools.length).toBeGreaterThan(0);
    expect(result.pools.every((p) => p.state?.block_hash === BLOCK8 && p.liquidity_eligible)).toBe(true);
    expect(result.pools.some((p) => p.eligibility_reasons.includes('CANONICALITY_UNVERIFIED'))).toBe(false);
    expect(result.outcome).toBe('PARTIAL');
    expect(result.coverage.source_results).toContainEqual(expect.objectContaining({ source: 'rpc:canonical', status: 'FAILED', reason: 'CANONICALITY_CHECK_UNAVAILABLE' }));
    expect(inventoryV3Schema.safeParse(result).success).toBe(true);
    const ledger = info.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return null; } }).find((l) => l?.event === 'flashloan.inventory_round');
    expect(ledger).toMatchObject({ network: 'base', final_outcome: 'CHECK_UNAVAILABLE' });
    expect(ledger.pools_read).toBe(result.pools.length);
    marker();
  });
  it('still wipes every read on a proven reorg and labels it BLOCK_REORG', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { engine: e } = engine({ fault: 'reorg' });
    const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.block).toBeNull();
    expect(result.pools.every((p) => p.state === undefined && !p.liquidity_eligible && p.eligibility_reasons.includes('BLOCK_REORG'))).toBe(true);
    expect(inventoryV3Schema.safeParse(result).success).toBe(true);
  });
  it('verifies the pinned block on the healthy path and emits the budget ledger', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { engine: e } = engine();
    const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.block?.hash).toBe(BLOCK8);
    expect(result.coverage.source_results.some((s) => s.source === 'rpc:canonical')).toBe(false);
    const ledger = info.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return null; } }).find((l) => l?.event === 'flashloan.inventory_round');
    expect(ledger).toMatchObject({ final_outcome: 'VERIFIED', final_calls: 1 });
    expect(ledger.read_calls).toBeGreaterThan(0);
  });
});

// A4: reviewed Arbitrum registry block (merge into FLASHLOAN_DISCOVERY_REGISTRY.networks.arbitrum).
const arbitrumBlock = JSON.parse(readFileSync(new URL('../services/flashloan/registry/arbitrum.reviewed.json', import.meta.url), 'utf8'));

describe('reviewed Arbitrum registry block', () => {
  it('parses under the strict registry schema with unique ids and only research-status dynamic-fee venues', () => {
    const config = discoveryRegistryConfigSchema.parse({ networks: { arbitrum: arbitrumBlock } });
    const registry = new DiscoveryRegistry(config);
    const network = registry.network('arbitrum');
    expect(network.venues.map((v) => v.id)).toEqual(expect.arrayContaining(['uniswap-v3', 'uniswap-v4', 'pancake-v3', 'camelot-algebra', 'sushi-v2', 'slipstream-arb', 'deltaswap']));
    expect(network.venues.find((v) => v.id === 'deltaswap')?.status).toBe('research');
    expect(network.lenders.filter((l) => l.fee_bps === 0).map((l) => l.id).sort()).toEqual(['balancer-v2', 'morpho-blue']);
    expect(network.anchors.every((a) => a.startsWith('eip155:42161/'))).toBe(true);
  });
});

const live = process.env.FLASHLOAN_LIVE === '1';
const rpcUrl = process.env.FLASHLOAN_ARBITRUM_RPC ?? 'https://arb1.arbitrum.io/rpc';
const call = async (method: string, params: unknown[]) => {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: string; error?: unknown }; if (!body.result) throw new Error(method + ' failed'); return body.result;
};
const word = (v: string) => v.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const ethCall = (to: string, data: string) => call('eth_call', [{ to, data }, 'latest']);
// One canonical pool per venue, verified 2026-11-22: [pool, selector-args builder]
const samples: Record<string, { pool: string; lookup: (t0: string, t1: string, pool: string) => Promise<string> }> = {
  'pancake-v3': { pool: '0x9ffca51d23ac7f7df82da414865ef1055e5afcc3', lookup: async (t0, t1, p) => ethCall(arbitrumBlock.venues.find((v: { id: string }) => v.id === 'pancake-v3').factory, '0x1698ee82' + word(t0) + word(t1) + word((await ethCall(p, '0xddca3f43')).slice(-6))) },
  'camelot-algebra': { pool: '0xe8795cf9c2309ecfe05df028eb0f21d5d6e3a951', lookup: async (t0, t1) => ethCall(arbitrumBlock.venues.find((v: { id: string }) => v.id === 'camelot-algebra').factory, '0xd9a641e1' + word(t0) + word(t1)) },
  'sushi-v2': { pool: '0x7050a8908e2a60899d8788015148241f0993a3fd', lookup: async (t0, t1) => ethCall(arbitrumBlock.venues.find((v: { id: string }) => v.id === 'sushi-v2').factory, '0xe6a43905' + word(t0) + word(t1)) },
  'slipstream-arb': { pool: '0xbdf6749254c8760b42f38b9985baaf1cecf17617', lookup: async (t0, t1, p) => ethCall(arbitrumBlock.venues.find((v: { id: string }) => v.id === 'slipstream-arb').factory, '0x28af8d0b' + word(t0) + word(t1) + word((await ethCall(p, '0xd0c93a7c')).slice(-6))) },
};
describe.skipIf(!live)('reviewed Arbitrum registry block matches chain state (live)', () => {
  it('pins every factory, StateView and lender runtime hash', async () => {
    const pinned = [
      ...arbitrumBlock.venues.map((v: { factory: string; factory_code_hash: string }) => [v.factory, v.factory_code_hash]),
      ...arbitrumBlock.venues.filter((v: { state_view?: string }) => v.state_view).map((v: { state_view: string; state_view_code_hash: string }) => [v.state_view, v.state_view_code_hash]),
      ...arbitrumBlock.lenders.map((l: { address: string; code_hash: string }) => [l.address, l.code_hash]),
    ] as Array<[string, string]>;
    for (const [address, expected] of pinned) expect(keccak256((await call('eth_getCode', [address, 'latest'])) as Hex), address).toBe(expected);
  }, 60_000);
  it('each reviewed venue factory registers its sample pool', async () => {
    for (const [id, sample] of Object.entries(samples)) {
      const t0 = '0x' + (await ethCall(sample.pool, '0x0dfe1681')).slice(-40), t1 = '0x' + (await ethCall(sample.pool, '0xd21220a7')).slice(-40);
      expect('0x' + (await sample.lookup(t0, t1, sample.pool)).slice(-40), id).toBe(sample.pool);
    }
  }, 60_000);
});
