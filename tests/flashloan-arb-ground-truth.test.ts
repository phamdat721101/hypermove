// @vitest-environment node
// M6 seam evidence (marker FLARB_EDGE_02): PRD-C ground truth — two tiers, authenticated emitters, ordered event dataset.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { JsonClient, RoundBudget } from '../src/lib/mcp/flashloan/transport';
import { deploymentSchema, emitterProofCache } from '../src/lib/mcp/flashloan/evm';
import { DiscoveryRegistry } from '../src/lib/mcp/flashloan/discovery-registry';
import { MemoryRepository, MemoryV4InitializeIndex } from '../src/lib/mcp/flashloan/storage';
import { groundTruthInputSchema, hash, GROUND_TRUTH_OPERATION } from '../src/lib/mcp/flashloan/contracts';
import { arbGroundTruthDocumentSchema, arbEventDatasetPageSchema } from '../src/lib/mcp/flashloan/arb-contracts';
import { decodePoolEvent, measureArbGroundTruth, reconcileReceipt, swapperDelta, GT_TOPICS, type GtReceipt } from '../src/lib/mcp/flashloan/arb-ground-truth';
import { ResearchWorker } from '../src/lib/mcp/flashloan/worker';
import { getFlashloanTools } from '../src/lib/mcp/flashloan/tools';
import { fakeChain, registry, scenario, tx, v4Entry, BOT, EOA, FORGED, P1, P2, H, WETH, USDC, type ChainOptions, type FxTx } from './fixtures/flashloan-arb-gt';

afterEach(() => { vi.unstubAllEnvs(); emitterProofCache.clear(); });
const marker = () => console.log(JSON.stringify({ event: 'flashloan.arb.edge', marker: 'FLARB_EDGE_02', passed: true }));
const asset = (a: string) => 'eip155:42161/erc20:' + a;
const input = (over: Record<string, unknown> = {}) => groundTruthInputSchema.parse({ idempotency_key: 'gt', network: 'arbitrum', from_block: '1000', to_block: '2000', ...over });

async function run(txs: FxTx[] = scenario(), options: ChainOptions = {}, over: Record<string, unknown> = {}) {
  const chain = fakeChain(txs, options), repo = new MemoryRepository(), index = new MemoryV4InitializeIndex();
  await index.put([v4Entry]);
  const budget = new RoundBudget({ maxRpcCalls: 2000, maxEvaluations: 0, deadlineMs: 30000 }, new AbortController().signal);
  try {
    const doc = await measureArbGroundTruth({ rpc: new JsonClient('https://rpc.test', chain.fetcher, 15000, budget), budget, network: 'arbitrum', registry, deployments: [], initializeIndex: index,
      cacheKey: (inputs) => hash(inputs), publish: (kind, key, data) => repo.publishShared(kind, key, data) }, input(over));
    return { doc: arbGroundTruthDocumentSchema.parse(doc), chain, repo };
  } finally { budget.dispose(); }
}
const record = (doc: z.infer<typeof arbGroundTruthDocumentSchema>, hashValue: string) => doc.records.find((r) => r.tx === hashValue);

describe('tier 1 swap-surplus candidates and tier 2 verified realized (C-T1, file 11 #14)', () => {
  it('a 2-pool closed loop gives one candidate, reconciled to verified_realized with gas, priority and trigger', async () => {
    const { doc } = await run();
    expect(doc.outcome).toBe('SUCCESS');
    const loop = record(doc, tx.loop)!;
    expect(loop).toMatchObject({ tier: 'verified_realized', tx_index: 5, from: EOA, to: BOT, net_by_asset: { [asset(WETH)]: (10n ** 16n).toString() }, gross_usd: '20', gas_usd: '0.04', net_usd: '19.96', priority_gwei: '0.01', trigger: { tx: tx.trigger, tx_index: 2, shared_pools: [P1] } });
    expect(doc.prices.map((p) => p.usd)).toEqual(['2000', '60000']);
    marker();
  });
  it('an aggregator A→B→C user swap is never a candidate', async () => {
    const { doc } = await run();
    expect(record(doc, tx.aggregator)).toBeUndefined();
    expect(doc.totals.multi_pool_txs).toBeGreaterThanOrEqual(5);
  });
  it('a forged Swap emitter is excluded as unauthenticated and never enters the dataset (#8)', async () => {
    const { doc, repo } = await run();
    expect(record(doc, tx.forged)).toBeUndefined();
    expect(doc.coverage.unauthenticated_emitters).toBe(1);
    expect(doc.coverage.excluded_counts).toMatchObject({ EMITTER_DEPLOYMENT_MISMATCH: 1, TX_WITH_UNAUTHENTICATED_SWAP: 1 });
    const page = arbEventDatasetPageSchema.parse((await repo.artifact('@shared', doc.dataset.pages[0].artifact_id)).data);
    expect(page.events.some((e) => e.emitter === FORGED)).toBe(false);
  });
  it('a lender fee that consumes the swap surplus stays a candidate and is not verified_realized (#10)', async () => {
    const { doc } = await run();
    expect(record(doc, tx.lenderFee)).toMatchObject({ tier: 'swap_surplus_candidate', net_by_asset: { [asset(USDC)]: '500000' }, gross_usd: '0.5' });
    expect(reconcileReceipt({ receipt: receiptOf(tx.lenderFee), canonicalHash: H(1800), wrapped: { address: WETH, style: 'transfer' }, swapAssets: new Set([USDC]), nativeSwapperDelta: 0n, lenders: new Set(['0xba12222222228d8ba445958a75a0704d566bf2c8']) })).toEqual({ ok: false, reason: 'REALIZED_NOT_POSITIVE' });
    // The same flash loan received by a third contract cannot be reconciled at all.
    const other = receiptOf(tx.lenderFee); other.logs[0] = { ...other.logs[0], topics: [other.logs[0].topics[0], H(0xdead), other.logs[0].topics[2]] };
    expect(reconcileReceipt({ receipt: other, canonicalHash: H(1800), wrapped: { address: WETH, style: 'transfer' }, swapAssets: new Set([USDC]), nativeSwapperDelta: 0n, lenders: new Set(['0xba12222222228d8ba445958a75a0704d566bf2c8']) })).toEqual({ ok: false, reason: 'FLASH_RECEIVER_NOT_BENEFICIARY' });
  });
  it('native ETH inside a cycle folds into WETH: wrapped back → verified, kept native → candidate only (#11)', async () => {
    const { doc } = await run();
    expect(record(doc, tx.wrapLoop)).toMatchObject({ tier: 'verified_realized', net_by_asset: { [asset(WETH)]: (10n ** 16n).toString() } });
    expect(record(doc, tx.wrapLoop)!.hops.map((h) => h.pool_ref)).toEqual([P1, v4Entry.pool_id]);
    expect(record(doc, tx.nativeKept)).toMatchObject({ tier: 'swap_surplus_candidate', net_by_asset: { [asset(WETH)]: (10n ** 16n).toString() } });
    expect(doc.totals).toMatchObject({ candidates: 4, verified: 2, candidate_gross_usd: '60.5' });
    expect(doc.unverified_reasons).toEqual({ REALIZED_NOT_POSITIVE: 2 });
  });
  it('several logs in one tx are applied in (tx_index, log_index) order even when served out of order (#6)', async () => {
    const { doc, repo } = await run();
    expect(record(doc, tx.loop)!.hops.map((h) => h.pool_ref)).toEqual([P1, P2]);
    const page = arbEventDatasetPageSchema.parse((await repo.artifact('@shared', doc.dataset.pages[0].artifact_id)).data);
    const keys = page.events.map((e) => [BigInt(e.block), e.tx_index, e.log_index] as const);
    expect(keys.every((k, i) => i === 0 || k[0] > keys[i - 1][0] || (k[0] === keys[i - 1][0] && (k[1] > keys[i - 1][1] || (k[1] === keys[i - 1][1] && k[2] > keys[i - 1][2]))))).toBe(true);
    expect(doc.dataset).toMatchObject({ complete: true, total_events: 13, by_kind: { swap_v3: 9, swap_v2: 1, sync: 1, swap_v4: 2 } });
    expect(page.events.find((e) => e.kind === 'sync')).toMatchObject({ fields: { reserve0: '1000000000000', reserve1: '1000000000000' } });
    expect(page.events.every((e) => e.block_hash === H(Number(e.block)))).toBe(true);
  });
});

describe('inconclusive instead of fabricated (#12, #13)', () => {
  it('a pruned archive makes the job INCONCLUSIVE before any log scan', async () => {
    const { doc, chain } = await run(scenario(), { archivePruned: true });
    expect(doc).toMatchObject({ outcome: 'INCONCLUSIVE', records: [], coverage: { archive: 'missing' } });
    expect(doc.reason).toMatch(/^ARCHIVE_UNAVAILABLE: RPC_METHOD_FAILED/);
    expect(chain.count('eth_getLogs')).toBe(0);
    marker();
  });
  it('a reorged receipt (blockHash mismatch) is rejected, never counted', async () => {
    const { doc } = await run(scenario(), { reorgReceipts: [tx.loop] });
    expect(record(doc, tx.loop)).toBeUndefined();
    expect(doc).toMatchObject({ outcome: 'INCONCLUSIVE', reason: 'RECEIPT_REORGED: 1', totals: { receipts_rejected: 1 } });
    expect(reconcileReceipt({ receipt: { ...receiptOf(tx.loop), blockHash: H(777777) }, canonicalHash: H(1500), wrapped: { address: WETH, style: 'transfer' }, swapAssets: new Set([WETH]), nativeSwapperDelta: 0n, lenders: new Set() })).toEqual({ ok: false, reason: 'RECEIPT_REORGED' });
  });
  it('a missing receipt leaves gas unknown, so the window is INCONCLUSIVE', async () => {
    const { doc } = await run(scenario(), { dropReceipts: [tx.wrapLoop] });
    expect(doc).toMatchObject({ outcome: 'INCONCLUSIVE', reason: 'RECEIPTS_MISSING: 1', totals: { receipts_missing: 1 } });
  });
});

describe('V4 sign convention (C-T2)', () => {
  it('a recorded V4 Swap (tx 0x355d57fb…, manager 0x360e68fa) nets to the ERC-20 flows into and out of the manager', () => {
    const receipt = JSON.parse(readFileSync(join(__dirname, 'fixtures/flashloan-arb-gt-v4-receipt.json'), 'utf8')) as GtReceipt;
    const manager = '0x360e68faccca8ca495c1b759fd9eee466db9fb32';
    const swap = receipt.logs.find((l) => l.address === manager && l.topics[0] === GT_TOPICS.swap_v4)!;
    const [d0, d1] = swapperDelta(decodePoolEvent(swap as never)!);
    const flow = (token: string) => receipt.logs.filter((l) => l.address === token && l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
      .reduce((n, l) => n + ('0x' + l.topics[1].slice(26) === manager ? BigInt(l.data) : 0n) - ('0x' + l.topics[2].slice(26) === manager ? BigInt(l.data) : 0n), 0n); // manager → out positive
    expect(d0).toBe(flow(USDC)); // swapper paid USDC: negative delta, matching USDC sent into the manager
    expect(d1).toBe(flow('0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9')); // swapper received USDT from the manager
    expect(d0 < 0n && d1 > 0n).toBe(true);
    // The V3 family reports the pool's view, so the same economic swap carries the opposite sign.
    expect(swapperDelta({ kind: 'swap_v3', fields: { amount0: (-d0).toString(), amount1: (-d1).toString() } })).toEqual([d0, d1]);
  });
});

describe('flashloan_arb_ground_truth_v1 job (flag, shared dedupe, polling, timeout)', () => {
  const baseNames = ['sui_ingest_pool_state', 'sui_solve_arbitrage_routes', 'sui_simulate_ptb', 'flashloan_discover_arbitrage_pools', 'flashloan_ingest_l2_tickmap_and_reserves', 'flashloan_solve_dynamic_route_split', 'flashloan_simulate_atomic_revm', 'xrpl_discover_arbitrage_routes', 'xrpl_simulate_arbitrage_route', 'nim_memory_sync_flashloan_lesson', 'flashloan_research_job'];
  async function worker() {
    const root = await mkdtemp(join(tmpdir(), 'flashloan-gt-')), chain = fakeChain(scenario()), repo = new MemoryRepository(), index = new MemoryV4InitializeIndex();
    await index.put([v4Entry]);
    return { root, chain, repo, worker: new ResearchWorker({ repo, endpoints: { arbitrum: 'https://rpc.test' }, deployments: [], root, fetcher: chain.fetcher, discoveryRegistry: registry, initializeIndex: index }) };
  }
  it('flag off: tool list, capabilities and dispatch are unchanged', async () => {
    const f = await worker();
    try {
      // Hash of the wire tool list captured on the pre-M6 code (commit bca21e6): flag off must be byte-identical.
      const wire = getFlashloanTools().map(({ name, description, tier, requiresAuthentication, inputSchema }) => ({ name, description, tier, requiresAuthentication, inputSchema }));
      expect(createHash('sha256').update(JSON.stringify(wire)).digest('hex')).toBe('335f0175c9f94f52a056a5fb8ae4c8b413ce09cf8747611b37f0ab8b57ecf0ff');
      expect([...f.worker.capabilities().operations].sort()).toEqual([...baseNames].sort());
      await expect(f.worker.dispatch('alice', GROUND_TRUTH_OPERATION, input())).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it('flag on: duplicate requests dedupe onto one shared job any caller can poll, and the result is a shared artifact', async () => {
    vi.stubEnv('FLASHLOAN_ARB_GT_V1', 'true');
    const f = await worker();
    try {
      expect(getFlashloanTools().map((t) => t.name)).toContain(GROUND_TRUTH_OPERATION);
      const a = await f.worker.dispatch('alice', GROUND_TRUTH_OPERATION, input()) as { id: string };
      const b = await f.worker.dispatch('bob', GROUND_TRUTH_OPERATION, input({ idempotency_key: 'other' })) as { id: string };
      expect(b.id).toBe(a.id);
      const timers = vi.spyOn(globalThis, 'setTimeout');
      await f.worker.tick();
      expect(timers.mock.calls.some(([, ms]) => ms === 300_000)).toBe(true); // per-operation worker deadline
      timers.mockRestore();
      const job = await f.worker.dispatch('bob', 'flashloan_research_job', { operation: 'get', job_id: a.id }) as { state: string; result_id: string };
      expect(job.state).toBe('SUCCEEDED');
      const ref = (await f.worker.dispatch('carol', 'flashloan_research_job', { operation: 'artifact', artifact_id: job.result_id }) as { data: { artifact_id: string; outcome: string; reused: boolean } }).data;
      expect(ref).toMatchObject({ outcome: 'SUCCESS', reused: false });
      const doc = arbGroundTruthDocumentSchema.parse((await f.worker.dispatch('carol', 'flashloan_research_job', { operation: 'artifact', artifact_id: ref.artifact_id }) as { data: unknown }).data);
      expect(doc.totals.candidates).toBe(4);
      // A later identical explicit window reuses the published document instead of rescanning.
      const again = await f.worker.dispatch('dave', GROUND_TRUTH_OPERATION, input()) as { id: string };
      expect(again.id).not.toBe(a.id);
      const scans = f.chain.count('eth_getLogs');
      await f.worker.tick();
      const second = await f.worker.dispatch('dave', 'flashloan_research_job', { operation: 'get', job_id: again.id }) as { result_id: string };
      expect((await f.worker.dispatch('dave', 'flashloan_research_job', { operation: 'artifact', artifact_id: second.result_id }) as { data: { reused: boolean; artifact_id: string } }).data).toMatchObject({ reused: true, artifact_id: ref.artifact_id });
      expect(f.chain.count('eth_getLogs')).toBe(scans);
      // Private jobs stay private: a shared lookup never resolves another owner's job.
      const own = await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', { idempotency_key: 'p', network: 'base', tokens: ['0x' + '12'.repeat(20)] });
      await expect(f.worker.dispatch('bob', 'flashloan_research_job', { operation: 'get', job_id: own.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await f.worker.scheduleGroundTruth()).toHaveLength(1); // arbitrum is the only configured network
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.env.FLASHLOAN_LIVE !== '1')('C-E2E live pinned window (Arbitrum 526391976–526406321, include_v4:false)', () => {
  it('measures the pinned window or reports INCONCLUSIVE honestly', async () => {
    const reviewed = new DiscoveryRegistry({ networks: { arbitrum: JSON.parse(readFileSync(join(__dirname, '../services/flashloan/registry/arbitrum.reviewed.json'), 'utf8')) } });
    const deployments = z.array(deploymentSchema).parse(JSON.parse(readFileSync(join(__dirname, '../services/flashloan/registry/arbitrum.deployments.json'), 'utf8')));
    const repo = new MemoryRepository(), budget = new RoundBudget({ maxRpcCalls: 6000, maxEvaluations: 0, deadlineMs: 270_000 }, new AbortController().signal);
    const started = performance.now();
    const doc = arbGroundTruthDocumentSchema.parse(await measureArbGroundTruth({ rpc: new JsonClient(process.env.FLASHLOAN_ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc', fetch, 30000, budget), budget, network: 'arbitrum', registry: reviewed, deployments,
      cacheKey: (inputs) => hash(inputs), publish: (kind, key, data) => repo.publishShared(kind, key, data) }, input({ from_block: '526391976', to_block: '526406321', include_v4: false })));
    budget.dispose();
    const top = doc.records.slice().sort((a, b) => Number(b.gross_usd) - Number(a.gross_usd))[0];
    console.log(JSON.stringify({ event: 'flashloan.arb.gt_live', outcome: doc.outcome, reason: doc.reason, elapsed_s: Math.round((performance.now() - started) / 1000), rpc_calls: budget.rpcCallsUsed, totals: doc.totals,
      unauthenticated_emitters: doc.coverage.unauthenticated_emitters, pools_considered: doc.coverage.pools_considered, unpriced: doc.coverage.unpriced, excluded: doc.coverage.excluded_counts, unverified: doc.unverified_reasons, dataset: { events: doc.dataset.total_events, by_kind: doc.dataset.by_kind },
      top: top && { tx: top.tx, tier: top.tier, gross_usd: top.gross_usd, net_usd: top.net_usd, trigger: top.trigger } }));
    if (doc.outcome === 'INCONCLUSIVE') { expect(doc.reason).toBeTruthy(); return; }
    // Authentication can only remove prototype candidates (reviewed venues only); it never adds any.
    expect(doc.totals.candidates_priced).toBeLessThanOrEqual(Math.ceil(243 * 1.02));
    const pinned = doc.records.find((r) => r.tx === '0xa6c6e2bde663197d073e841b188b0e5c6ac77f7fd2aebe7eb113bf1bc05a896f');
    expect(pinned?.trigger).toMatchObject({ tx: '0x355d57fbe6e147b9473dd178dd7ac6b4c2dec31a59a63ccb32035c16e425575f', tx_index: 2 });
    expect(top.tx).toBe(pinned!.tx);
    expect(Math.abs(Number(pinned!.gross_usd) - 10.74) / 10.74).toBeLessThan(0.03); // prototype top arb $10.74
  }, 320_000);
});

/** Receipts exactly as the RPC fake serves them, for direct reconcileReceipt checks. */
const receipts = new Map<string, GtReceipt>();
for (const h of Object.values(tx)) {
  const res = await fakeChain(scenario()).fetcher('https://rpc.test', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [h] }) });
  receipts.set(h, (await res.json() as { result: GtReceipt }).result);
}
function receiptOf(hashValue: string): GtReceipt { return structuredClone(receipts.get(hashValue)!); }
