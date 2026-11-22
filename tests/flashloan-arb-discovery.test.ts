// @vitest-environment node
// EDGE-01 (seam: discovery) for docs/features/flashloan-mcp-arb-upgrade-map.md.
// D1: an exhausted round budget made the final canonicality check fail and erased every pool.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchEngine } from '../src/lib/mcp/flashloan/engine';
import { inventoryV3Schema } from '../src/lib/mcp/flashloan/v8-contracts';
import { RoundBudget } from '../src/lib/mcp/flashloan/transport';
import { ResearchError } from '../src/lib/mcp/flashloan/contracts';
import { fixtureV8, A8, BLOCK8 } from './fixtures/flashloan-v8';

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
