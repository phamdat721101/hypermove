import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeFunctionData, parseAbi, keccak256, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { ResearchError, hash, LENDER_PROVIDERS, type Input, type PoolRef, type quoteCycleInputSchema } from './contracts';
import { EvmReader, evmSnapshotSchema, type EvmSnapshot, type Header } from './evm';
import { quotePool, lenderRoutablePools, applyEventState, decodePoolEvent, sizeCycle, POOL_EVENT_TOPICS, type Pool, type Route, type DecodedPoolEvent } from './math';
import { arbCycleId, assetAddress, cycleQuoteSchema, type ArbDatasetEvent, type ArbGroundTruthDocument, type CycleQuote } from './arb-contracts';
import { cycleRoute, liveLenders, routeSignatures, sameCycle, universePoolRef, type UniversePayload } from './arb-universe';
import { chainlinkUnitPrices, formatUsd, gasEvidence, probeArchive, rawForUsd, recordSignature, usdValuer, weiToBorrowRaw } from './arb-ground-truth';
import { assetId } from './v8-contracts';
import type { DiscoveryRegistry } from './discovery-registry';

export const planSchema = z.object({ snapshot_id: z.string(), snapshot: evmSnapshotSchema, borrow_asset: z.string(), policy: z.object({ network_cost: z.string(), min_profit: z.string() }).passthrough(), solution: z.object({ principal: z.string(), allocations: z.array(z.object({ route: z.object({ id: z.string(), hops: z.array(z.object({ pool: z.string(), token_in: z.string(), token_out: z.string() })) }), amount: z.string() })), expected_profit: z.string() }).passthrough() }).passthrough();
export type Plan = z.infer<typeof planSchema>;
const executorAbi = parseAbi(['function executeMixed(address source,uint8 provider,address token,uint256 amount,(address pool,address tokenIn,address tokenOut,uint8 kind,uint256 amountIn,uint256 minOut)[] steps,(uint256 index,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key)[] extra,uint256 minProfit) returns(uint256 profit)', 'function execute(address source,uint8 provider,address token,uint256 amount,(address pool,address tokenIn,address tokenOut,uint8 kind,uint256 amountIn,uint256 minOut)[] steps,uint256 minProfit) returns(uint256 profit)']);
export function compilePlan(plan: Plan, executor: string) {
  const state = new Map<string, Pool>(plan.snapshot.pools.map((p) => [p.address, p]));
  const steps: Array<{ pool: Address; tokenIn: Address; tokenOut: Address; kind: number; amountIn: bigint; minOut: bigint }> = [];
  const extra: Array<{ index: bigint; key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } }> = [];
  for (const allocation of plan.solution.allocations) {
    let amount = BigInt(allocation.amount);
    for (const hop of allocation.route.hops) {
      const pool = state.get(hop.pool); if (!pool) throw new ResearchError('INVALID_ROUTE', 'Plan references missing pool.');
      if (!lenderRoutablePools([pool], plan.snapshot.lender).length) throw new ResearchError('LENDER_POOL_LOCK', 'Flash lender pool cannot also be swapped during its callback.');
      const quote = quotePool(pool, hop.token_in, amount);
      if (pool.kind === 'clmm' && pool.v4) extra.push({ index: BigInt(steps.length), key: pool.v4.key as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } });
      steps.push({ pool: (pool.kind === 'wrap' ? pool.wrapped_native : pool.kind === 'clmm' && pool.v4 ? pool.v4.manager : pool.address) as Address, tokenIn: hop.token_in as Address, tokenOut: hop.token_out as Address, kind: pool.kind === 'wrap' ? pool.direction === 'unwrap' ? 3 : 4 : pool.kind === 'v2' ? 0 : pool.v4 ? 2 : 1, amountIn: amount, minOut: quote.amount_out });
      state.set(pool.address, quote.pool); amount = quote.amount_out;
    }
  }
  const provider = (LENDER_PROVIDERS as readonly string[]).indexOf(plan.snapshot.lender.provider);
  if (provider < 0) throw new ResearchError('UNSUPPORTED_LENDER', 'Plan lender is unsupported.');
  const args = [plan.snapshot.lender.address as Address, provider, plan.borrow_asset as Address, BigInt(plan.solution.principal), steps] as const;
  const minProfit = BigInt(plan.policy.min_profit) + BigInt(plan.policy.network_cost);
  const data = extra.length ? encodeFunctionData({ abi: executorAbi, functionName: 'executeMixed', args: [...args, extra, minProfit] }) : encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [...args, minProfit] });
  return { to: executor, data, calldata_hash: keccak256(data), plan_hash: hash(plan) };
}
const engineOutput = z.object({ version: z.literal(1), success: z.boolean(), gas_used: z.string().regex(/^\d+$/), output: z.string(), logs: z.array(z.object({ address: z.string(), topics: z.array(z.string()), data: z.string() })), engine: z.string(), chain_native: z.literal(false) });
export type EngineOutput = z.infer<typeof engineOutput>;
export type EngineAdapter = (request: Record<string, unknown>, signal?: AbortSignal) => Promise<EngineOutput>;
export const runNativeEngine: EngineAdapter = (request, signal) => new Promise((resolveResult, reject) => {
  const binary = process.env.FLASHLOAN_ENGINE ?? resolve('services/flashloan/target/release/flashloan-engine');
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV } });
  let output = '', diagnostics = ''; let settled = false;
  const end = (error?: Error, value?: EngineOutput) => {
    if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); child.kill('SIGKILL');
    const settle = () => { if (error) reject(error); else resolveResult(value!); };
    if (child.exitCode !== null || child.signalCode !== null) settle();
    else child.once('close', settle);
  };
  const abort = () => end(new ResearchError('CANCELLED', 'EVM simulation cancelled.'));
  const timer = setTimeout(() => end(new ResearchError('SIMULATION_TIMEOUT', 'Rust simulation exceeded its deadline.', true)), 45000);
  if (signal?.aborted) { abort(); return; } signal?.addEventListener('abort', abort, { once: true });
  child.on('error', () => end(new ResearchError('ENGINE_UNAVAILABLE', 'Build the configured Rust simulation engine.')));
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 8_000_000) end(new ResearchError('ENGINE_OUTPUT_BUDGET', 'Rust output exceeded its byte budget.')); });
  child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-4000); });
  child.on('close', (code) => {
    if (code !== 0) { end(new ResearchError('ENGINE_FAILED', 'Rust engine exited without a verified report.')); return; }
    try { const parsed = JSON.parse(output); if (!parsed.ok) throw new ResearchError('SIMULATION_INCONCLUSIVE', `Fork execution failed: ${String(parsed.error).slice(0, 100)}`); end(undefined, engineOutput.parse(parsed.data)); }
    catch (e) { end(e instanceof ResearchError ? e : new ResearchError('ENGINE_PROTOCOL', 'Invalid Rust engine response.')); }
    void diagnostics;
  });
  child.stdin.on('error', () => end(new ResearchError('ENGINE_PROTOCOL', 'Engine input channel failed.')));
  child.stdin.end(JSON.stringify(request) + '\n');
});
export async function simulatePlan(reader: EvmReader, rawPlan: unknown, input: Input<'flashloan_simulate_atomic_revm'>, engine: EngineAdapter = runNativeEngine, signal?: AbortSignal) {
  const plan = planSchema.parse(rawPlan); const snapshot: EvmSnapshot = plan.snapshot;
  const current = await reader.rpc.rpc<{ hash: string } | null>('eth_getBlockByNumber', [snapshot.block.number, false], signal);
  if (!current || current.hash !== snapshot.block.hash) throw new ResearchError('REORG', 'Plan block is no longer canonical.');
  const compiled = compilePlan(plan, input.executor);
  const assumptions: string[] = ['Execution uses a Cancun-configured generic EVM; chain-specific hardfork and precompile parity must be checked against the reference node.', 'Network cost in the funding asset is an explicit sizing-policy assumption, not a live USD valuation.'];
  let executorCode: Hex; let executorStorage: Record<string, string> = {};
  try {
    const artifact = JSON.parse(await readFile(process.env.FLASHLOAN_EXECUTOR_ARTIFACT ?? resolve('services/flashloan/out/ResearchExecutor.sol/ResearchExecutor.json'), 'utf8'));
    executorCode = artifact.deployedBytecode.object;
    if (!/^0x[0-9a-fA-F]+$/.test(executorCode)) throw Error('invalid bytecode');
  } catch { throw new ResearchError('EXECUTOR_UNAVAILABLE', 'Build the reviewed ResearchExecutor contract artifact.'); }
  if (input.executor_mode === 'existing') {
    const actual = await reader.rpc.rpc<Hex>('eth_getCode', [input.executor, { blockHash: snapshot.block.hash, requireCanonical: true }], signal);
    if (keccak256(actual) !== keccak256(executorCode)) throw new ResearchError('EXECUTOR_MISMATCH', 'Existing executor does not match the reviewed runtime.');
  } else {
    const existing = await reader.rpc.rpc<Hex>('eth_getCode', [input.executor, { blockHash: snapshot.block.hash, requireCanonical: true }], signal);
    if (existing !== '0x') throw new ResearchError('EXECUTOR_ADDRESS_OCCUPIED', 'Fixture overrides require an address without deployed code.');
    executorStorage = { ['0x' + '0'.repeat(64)]: '0x' + input.caller.slice(2).padStart(64, '0') };
    assumptions.push('Executor runtime and owner storage are injected at an empty address in the local fork only.');
  }
  const request = { version: 1, rpc_url: reader.rpc.url, block_hash: snapshot.block.hash, block_number: snapshot.block.number, timestamp: snapshot.block.timestamp, base_fee: snapshot.block.baseFeePerGas ?? '0x0', gas_limit: snapshot.block.gasLimit, coinbase: snapshot.block.miner, chain_id: snapshot.chain_id, caller: input.caller, executor: input.executor, calldata: compiled.data, ...(input.executor_mode === 'fixture' ? { executor_code: executorCode, executor_storage: executorStorage } : {}) };
  const local = await engine(request, signal);
  let reference: { matched: boolean; output?: string; error?: string };
  try {
    const params: unknown[] = [{ from: input.caller, to: input.executor, data: compiled.data, gas: '0x1c9c380', gasPrice: snapshot.block.baseFeePerGas ?? '0x0' }, { blockHash: snapshot.block.hash, requireCanonical: true }];
    if (input.executor_mode === 'fixture') params.push({ [input.executor]: { code: executorCode, stateDiff: executorStorage } });
    const output = await reader.rpc.rpc<string>('eth_call', params, signal);
    reference = { matched: local.success && output.toLowerCase() === local.output.toLowerCase(), output };
  } catch { reference = { matched: false, error: 'Reference eth_call unavailable or reverted; chain parity is not established.' }; }
  const profit = local.success && /^0x[a-fA-F0-9]{64}$/.test(local.output) ? BigInt(local.output).toString() : null;
  let network_fee: { status: string; gas_limit?: string; gas_price_wei?: string; estimated_fee_wei?: string; observed_at?: string; note: string };
  try {
    const request: Record<string, unknown> = { from: input.caller, to: input.executor, data: compiled.data };
    const params: unknown[] = [request, snapshot.block.number];
    if (input.executor_mode === 'fixture') params.push({ [input.executor]: { code: executorCode, stateDiff: executorStorage } });
    const [gas, price] = await Promise.all([reader.rpc.rpc<string>('eth_estimateGas', params, signal), reader.rpc.rpc<string>('eth_gasPrice', [], signal)]);
    if (!/^0x[0-9a-fA-F]+$/.test(gas) || !/^0x[0-9a-fA-F]+$/.test(price)) throw Error('Invalid fee estimate.');
    network_fee = { status: 'RPC_ESTIMATE', gas_limit: BigInt(gas).toString(), gas_price_wei: BigInt(price).toString(), estimated_fee_wei: (BigInt(gas) * BigInt(price)).toString(), observed_at: new Date().toISOString(), note: 'Native wei estimate; Robinhood RPC includes L1 data costs. Funding-asset conversion remains the explicit policy.network_cost assumption.' };
  } catch { network_fee = { status: 'UNAVAILABLE', note: 'RPC fee estimation failed; no fee was fabricated. policy.network_cost remains an explicit assumption.' }; }
  return { status: !local.success ? 'REJECTED' : reference.matched ? 'REFERENCE_DRY_RUN' : 'INCONCLUSIVE', verification_level: reference.matched ? 'RETURN_DATA_PARITY' : 'LOCAL_EVM_ONLY', network_fee, snapshot_hash: hash(snapshot), snapshot_block: snapshot.block, ...compiled, executor_code_hash: keccak256(executorCode), engine: local.engine, gas_used: local.gas_used, gross_profit_funding_units: profit, expected_net_profit_funding_units: profit === null ? null : (BigInt(profit) - BigInt(plan.policy.network_cost)).toString(), repayment: local.success ? 'CALLBACK_COMPLETED' : 'UNPROVEN', transfer_restrictions: local.success ? 'EXACT_ROUTE_PASSED' : 'CONTEXTUAL_REVERT', logs: local.logs, reference, assumptions, chain_native_verified: false, can_execute: false };
}

// ---------------- PRD-D cycle quote (file 11 §D #7–#11): data only, historical gas, event-sourced state ----------------
export type QuoteCycleInput = z.infer<typeof quoteCycleInputSchema>;
export type QuoteCycleDeps = {
  reader: EvmReader; signal: AbortSignal; registry: DiscoveryRegistry;
  /** The pinned universe (cycle_id form); null for inline hops. */
  universe: UniversePayload | null;
  /** Latest GT document: gas-unit and priority evidence. */
  groundTruth: ArbGroundTruthDocument | null;
  /** M6 event dataset for block B when a GT window covers it; null → read the block's logs. */
  datasetEvents?: (block: bigint) => Promise<ArbDatasetEvent[] | null>;
};
type BlockEvent = { pool: string; tx_index: number; log_index: number; block_hash: string; event: DecodedPoolEvent | undefined };
const V2_V3_EVENT_KINDS = ['swap_v3', 'swap_pancake', 'swap_v2', 'sync', 'mint_v3', 'burn_v3', 'mint_v2', 'burn_v2', 'fee_algebra'] as const;
const V4_EVENT_KINDS = ['swap_v4', 'modify_liquidity_v4', 'protocol_fee_v4'] as const;
/** Every decodable pool event of block B on the given pools (V4 through the manager, filtered by pool id), pinned by block hash. */
async function blockPoolLogs(reader: EvmReader, header: Header, pools: Pool[], signal: AbortSignal): Promise<BlockEvent[]> {
  type Log = { address: string; topics: string[]; data: string; transactionIndex: string; logIndex: string; blockHash: string };
  const logs: Log[] = [];
  const direct = pools.filter((p) => !(p.kind === 'clmm' && p.v4)).map((p) => p.address.toLowerCase());
  if (direct.length) logs.push(...await reader.rpc.rpc<Log[]>('eth_getLogs', [{ blockHash: header.hash, address: direct, topics: [V2_V3_EVENT_KINDS.map((k) => POOL_EVENT_TOPICS[k])] }], signal));
  const managers = new Map<string, string[]>();
  for (const p of pools) if (p.kind === 'clmm' && p.v4) (managers.get(p.v4.manager) ?? managers.set(p.v4.manager, []).get(p.v4.manager)!).push(p.address.toLowerCase());
  for (const [manager, ids] of managers) logs.push(...await reader.rpc.rpc<Log[]>('eth_getLogs', [{ blockHash: header.hash, address: manager, topics: [V4_EVENT_KINDS.map((k) => POOL_EVENT_TOPICS[k]), ids] }], signal));
  return logs.map((log) => ({ pool: (V4_EVENT_KINDS.some((k) => POOL_EVENT_TOPICS[k] === String(log.topics[0]).toLowerCase()) ? String(log.topics[1]) : log.address).toLowerCase(), tx_index: Number(BigInt(log.transactionIndex)), log_index: Number(BigInt(log.logIndex)), block_hash: String(log.blockHash).toLowerCase(), event: decodePoolEvent(log) }));
}
/**
 * One cycle, sized exactly after the trigger: state = end of B−1 (archive) plus every decoded log on the cycle's pools
 * with (tx_index, log_index) ≤ the end of the trigger tx, each pinned to the canonical hash of B. Gas is historical
 * (B's base fee, priority from input or the p75 of matched GT arbs, gas units from the GT median for the hop count).
 * PROFITABLE iff net ≥ margin; `executor_threshold_raw` (gas + margin) is informational. No calldata, no estimateGas.
 */
export async function quoteCycle(deps: QuoteCycleDeps, input: QuoteCycleInput): Promise<CycleQuote> {
  const { reader, signal } = deps, network = input.network, lower = (a: string) => a.toLowerCase();
  // 1. The cycle: a pinned universe cycle, or inline hops with explicit pool references.
  let route: Route, refs: PoolRef[], funding: string, cycleId: string, lenderIds: string[] | null = null;
  if ('cycle_id' in input.cycle) {
    const u = deps.universe;
    if (!u) throw new ResearchError('UNIVERSE_NOT_FOUND', 'The pinned universe is unavailable.', true);
    const id = input.cycle.cycle_id, cycle = u.cycles.find((c) => c.cycle_id === id);
    if (!cycle) throw new ResearchError('CYCLE_NOT_FOUND', 'The cycle is not in the pinned universe.');
    route = cycleRoute(cycle); funding = lower(assetAddress(cycle.funding_asset)); cycleId = cycle.cycle_id; lenderIds = cycle.lenders.map((l) => l.lender_id);
    refs = route.hops.map((h) => { const p = u.pools.find((x) => x.pool_ref === h.pool); if (!p) throw new ResearchError('INVALID_ROUTE', 'Cycle references a pool missing from the universe.'); return universePoolRef(p); });
  } else {
    const hops = input.cycle.hops; funding = lower(input.cycle.funding_asset);
    if (lower(hops[0].token_in) !== funding || lower(hops[hops.length - 1].token_out) !== funding || hops.some((h, i) => i > 0 && lower(hops[i - 1].token_out) !== lower(h.token_in))) throw new ResearchError('INVALID_ROUTE', 'Hops must chain from and back to the funding asset.');
    refs = hops.map((h) => ({ ...h.pool, address: lower(h.pool.address) }));
    const cycleHops = hops.map((h) => ({ pool_ref: lower(h.pool.address), token_in: assetId(network, lower(h.token_in)), token_out: assetId(network, lower(h.token_out)) }));
    cycleId = arbCycleId(assetId(network, funding), cycleHops);
    route = { id: cycleId, hops: hops.map((h) => ({ pool: lower(h.pool.address), token_in: lower(h.token_in), token_out: lower(h.token_out) })) };
  }
  // 2. Block B: the trigger receipts' block, else the input block, else head. Receipts must be canonical in B.
  const txSwaps = input.pre_swaps.flatMap((p) => 'tx_hash' in p ? [p.tx_hash] : []);
  const receipts: Array<{ blockNumber: string; blockHash: string; transactionIndex: string }> = [];
  for (const tx of txSwaps) {
    const r = await reader.rpc.rpc<{ blockNumber: string; blockHash: string; transactionIndex: string } | null>('eth_getTransactionReceipt', [tx], signal);
    if (!r) throw new ResearchError('RECEIPT_UNAVAILABLE', 'A pre_swap receipt is unavailable.', true);
    receipts.push(r);
  }
  const triggerBlocks = new Set(receipts.map((r) => BigInt(r.blockNumber)));
  if (triggerBlocks.size > 1 || (input.block !== undefined && receipts.length && !triggerBlocks.has(BigInt(input.block)))) throw new ResearchError('INVALID_INPUT', 'Every tx pre_swap must be in the quoted block.');
  const B = receipts.length ? BigInt(receipts[0].blockNumber) : input.block !== undefined ? BigInt(input.block) : BigInt((await reader.header(signal)).number);
  if (B === 0n) throw new ResearchError('INVALID_INPUT', 'Block 0 has no parent state.');
  const header = await reader.header(signal, B.toString()), prev = await reader.header(signal, (B - 1n).toString());
  if (lower(prev.hash) !== lower(header.parentHash)) throw new ResearchError('REORG', 'Block B and its parent are not one canonical chain; retry.', true);
  const reasons: string[] = [], flag = (r: string) => { if (!reasons.includes(r)) reasons.push(r); };
  if (receipts.some((r) => lower(r.blockHash) !== lower(header.hash))) flag('RECEIPT_REORGED');
  const cutoff = receipts.length ? Math.max(...receipts.map((r) => Number(BigInt(r.transactionIndex)))) : -1;
  const shell = (): CycleQuote => cycleQuoteSchema.parse({ cycle_id: cycleId, block: { number: B.toString(), hash: lower(header.hash), timestamp: BigInt(header.timestamp).toString() }, mode: 'historical', pre_swaps_applied: 0, principal_raw: '0', expected_out_raw: null, lender: null, gross_raw: null,
    gas: { gas_units: null, base_fee_wei: null, priority_bid_wei: null, gas_price_wei: null, cost_in_borrow_raw: null, eth_usd: null }, net_raw: null, net_usd: null, margin_raw: '0', executor_threshold_raw: null,
    outcome: 'INCONCLUSIVE', reason: reasons.slice(0, 3).join('; ').slice(0, 128), fidelity: { quote_capability: 'estimate', tick_words_loaded: 0, crossed_unloaded_tick: false, hooks: false } });
  // 3. End-of-(B−1) state; archive is required.
  const archive = await probeArchive(reader.rpc, prev, signal);
  if (archive) { flag('ARCHIVE_UNAVAILABLE: ' + archive); return shell(); }
  const state = new Map<string, Pool>();
  for (const ref of refs) {
    if (state.has(lower(ref.address))) continue;
    try { state.set(lower(ref.address), await reader.pool(ref, prev, signal, 2000)); }
    catch (e) {
      signal.throwIfAborted();
      if (!(e instanceof ResearchError) || ['QUOTE_UNSUPPORTED', 'UNSUPPORTED_HOOK'].includes(e.code)) throw e; // capability none is refused
      flag('STATE_UNAVAILABLE: ' + e.code); return shell();
    }
  }
  // 4. Replay every decoded log on the cycle pools up to the end of the trigger tx.
  const dataset = deps.datasetEvents ? await deps.datasetEvents(B) : null;
  const events: BlockEvent[] = dataset ? dataset.filter((e) => state.has(e.pool_ref)).map((e) => ({ pool: e.pool_ref, tx_index: e.tx_index, log_index: e.log_index, block_hash: e.block_hash, event: { kind: e.kind, fields: e.fields } }))
    : await blockPoolLogs(reader, header, [...state.values()], signal);
  let eventsExact = true;
  for (const e of events.filter((x) => x.tx_index <= cutoff).sort((a, b) => a.tx_index - b.tx_index || a.log_index - b.log_index)) {
    if (e.block_hash !== lower(header.hash)) { flag('RECEIPT_REORGED'); break; }
    if (!e.event) { eventsExact = false; flag('EVENT_STATE_APPROX: MALFORMED_LOG'); continue; }
    try { const applied = applyEventState(state.get(e.pool)!, e.event); state.set(e.pool, applied.pool); if (!applied.exact) { eventsExact = false; flag('EVENT_STATE_APPROX: ' + applied.reason); } }
    catch (err) { if (!(err instanceof ResearchError)) throw err; eventsExact = false; flag('EVENT_STATE_APPROX: ' + err.code); }
  }
  // Hypothetical pre_swaps run on the event-sourced state.
  let applied = receipts.length, crossedPre = false;
  for (const p of input.pre_swaps) {
    if ('tx_hash' in p) continue;
    const ref = lower(p.pool_ref), pool = state.get(ref);
    if (!pool) throw new ResearchError('INVALID_INPUT', 'A hypothetical pre_swap must target a cycle pool.');
    try { state.set(ref, quotePool(pool, lower(p.token_in), BigInt(p.amount_in_raw)).pool); applied++; }
    catch (e) { if (!(e instanceof ResearchError)) throw e; crossedPre ||= e.code === 'INSUFFICIENT_TICK_COVERAGE'; flag(e.code === 'INSUFFICIENT_TICK_COVERAGE' ? 'TICK_APPROX: PRE_SWAP_UNLOADED_TICK' : 'PRE_SWAP_FAILED: ' + e.code); }
  }
  // 5. Lender fee and capacity at B−1 (the cycle's lenders, cheapest routable first).
  const counts: Record<string, number> = {}, registryLenders = deps.registry.network(network).lenders.filter((l) => !lenderIds || lenderIds.includes(l.id));
  const routePools = route.hops.map((h) => state.get(h.pool)!);
  const lender = ((await liveLenders(reader, prev, registryLenders, network, [funding], signal, counts)).get(funding) ?? []).find((l) => lenderRoutablePools(routePools, l).length === routePools.length);
  if (!lender) { flag('LENDER_UNAVAILABLE' + (Object.keys(counts).length ? ': ' + Object.keys(counts)[0] : '')); return shell(); }
  // 6. Historical gas in borrow units.
  const feeds = await chainlinkUnitPrices(reader.rpc, network, header, signal), eth = feeds.unitPrice.get('ETH');
  const sigs = routeSignatures(route, state);
  const matched = (deps.groundTruth?.records ?? []).filter((r) => sameCycle(recordSignature(r), sigs.forward));
  const evidence = gasEvidence(deps.groundTruth, route.hops.length, matched);
  const priority = input.priority_bid_wei !== undefined ? BigInt(input.priority_bid_wei) : evidence.priority_p75_wei;
  const baseFee = header.baseFeePerGas !== undefined ? BigInt(header.baseFeePerGas) : null;
  const gasPrice = baseFee !== null && priority !== null ? baseFee + priority : null;
  const gasWei = gasPrice !== null && evidence.gas_units !== null ? gasPrice * evidence.gas_units : null;
  const cost = gasWei !== null ? weiToBorrowRaw(network, feeds.unitPrice, funding, gasWei) : null;
  if (!deps.groundTruth) flag('GROUND_TRUTH_UNAVAILABLE');
  if (evidence.gas_units === null) flag('GAS_UNITS_EVIDENCE_MISSING');
  if (priority === null) flag('PRIORITY_EVIDENCE_MISSING');
  if (baseFee === null) flag('BASE_FEE_MISSING');
  if (eth === undefined) flag('ETH_PRICE_MISSING');
  else if (gasWei !== null && cost === null) flag('BORROW_ASSET_UNPRICED');
  // 7. Size the fixed route (≈ $1 to the cap) and decide on margin only (the solver net already subtracts gas).
  const minPrincipal = rawForUsd(network, feeds.unitPrice, funding, 1_000_000n) ?? 1n;
  const sizing = sizeCycle(route, state, { capacity: lender.capacity_raw, fee_numerator: BigInt(Math.round(lender.fee_bps * 1e6)).toString(), fee_denominator: '10000000000', address: lender.address, provider: lender.provider },
    { min_principal: minPrincipal.toString(), max_principal: input.policy.max_principal, max_price_impact_bps: input.policy.max_price_impact_bps, max_evaluations: input.policy.max_evaluations, network_cost: (cost ?? 0n).toString() });
  if (sizing.status === 'INCONCLUSIVE') flag(sizing.reason!);
  const principal = sizing.principal ?? 0n;
  const margin = (() => { const bps = principal * BigInt(Math.round(input.policy.margin_bps * 100)) / 1_000_000n, raw = BigInt(input.policy.margin_raw); return bps > raw ? bps : raw; })();
  if (cost !== null && cost + margin === 0n) flag('ZERO_COST_POLICY');
  const net = cost !== null && sizing.net !== null ? sizing.net : null;
  const netMicro = net === null ? null : usdValuer(network, feeds.unitPrice)(funding, net);
  const outcome = reasons.length || net === null ? 'INCONCLUSIVE' : net >= margin ? 'PROFITABLE' : 'UNPROFITABLE';
  if (outcome === 'INCONCLUSIVE' && !reasons.length) flag('NET_UNAVAILABLE');
  return cycleQuoteSchema.parse({
    cycle_id: cycleId, block: { number: B.toString(), hash: lower(header.hash), timestamp: BigInt(header.timestamp).toString() }, mode: 'historical', pre_swaps_applied: applied,
    principal_raw: principal.toString(), expected_out_raw: sizing.expected_out?.toString() ?? null,
    lender: { lender_id: lender.lender_id, provider: lender.provider, fee_raw: (sizing.lender_fee ?? 0n).toString() }, gross_raw: sizing.gross?.toString() ?? null,
    gas: { gas_units: evidence.gas_units?.toString() ?? null, base_fee_wei: baseFee?.toString() ?? null, priority_bid_wei: priority?.toString() ?? null, gas_price_wei: gasPrice?.toString() ?? null, cost_in_borrow_raw: cost?.toString() ?? null, eth_usd: eth === undefined ? null : formatUsd(eth / 100n) },
    net_raw: net?.toString() ?? null, net_usd: netMicro === null ? null : formatUsd(netMicro), margin_raw: margin.toString(), executor_threshold_raw: cost === null ? null : (cost + margin).toString(),
    outcome, reason: outcome === 'INCONCLUSIVE' ? reasons.slice(0, 3).join('; ').slice(0, 128) : null,
    fidelity: { quote_capability: eventsExact && sizing.quote_capability === 'exact' ? 'exact' : 'estimate', tick_words_loaded: routePools.reduce((n, p) => n + (p.kind === 'clmm' ? p.word_max - p.word_min + 1 : 0), 0), crossed_unloaded_tick: sizing.crossed_unloaded_tick || crossedPre, hooks: false },
  });
}
