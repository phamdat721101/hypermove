import { decodeEventLog, keccak256, parseAbi, toEventSelector, toFunctionSelector, toHex, type AbiEvent, type Hex } from 'viem';
import { CHAINS, ResearchError, hash, type groundTruthInputSchema } from './contracts';
import type { z } from 'zod';
import { EvmReader, words, type Deployment, type EmitterAuth, type Header } from './evm';
import { boundedTopicLogs, delay, type JsonClient, type RoundBudget, type TopicLog, type TopicScan } from './transport';
import { resolveV4PoolKeys, type InitializationLocator } from './pool-resolution';
import type { V4InitializeIndex } from './storage';
import type { DiscoveryRegistry } from './discovery-registry';
import { assetId, emptyCoverage } from './v8-contracts';
import { ARB_DATASET_PAGE_EVENTS, arbEventDatasetPageSchema, arbGroundTruthDocumentSchema, arbRecordSchema, type ArbDatasetEvent, type ArbGroundTruthDocument, type ArbRecord, ARB_EVENT_KINDS } from './arb-contracts';

/**
 * PRD-C `flashloan_arb_ground_truth_v1` (amended by file 11 §C #14–#17): what closed-loop DEX arbs actually landed in a
 * block window. Tier 1 `swap_surplus_candidate` nets authenticated Swap deltas per tx (swapper view); tier 2
 * `verified_realized` reconciles the receipt's ERC-20 Transfers for tx.from/tx.to. Every missing input (archive, logs,
 * receipts, prices) is an explicit INCONCLUSIVE reason, never a fabricated value.
 */
export type GtNetwork = z.infer<typeof groundTruthInputSchema>['network'];
export type GroundTruthInput = z.infer<typeof groundTruthInputSchema>;
type EventKind = typeof ARB_EVENT_KINDS[number];

const topic = (signature: string) => keccak256(toHex(signature));
const EVENT_ABIS: Record<EventKind, string> = {
  swap_v3: 'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
  swap_pancake: 'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)',
  swap_v2: 'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
  swap_v4: 'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
  sync: 'event Sync(uint112 reserve0,uint112 reserve1)',
  mint_v3: 'event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
  burn_v3: 'event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
  mint_v2: 'event Mint(address indexed sender,uint256 amount0,uint256 amount1)',
  burn_v2: 'event Burn(address indexed sender,uint256 amount0,uint256 amount1,address indexed to)',
  modify_liquidity_v4: 'event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)',
};
const abiOf = Object.fromEntries(ARB_EVENT_KINDS.map((k) => [k, parseAbi([EVENT_ABIS[k]] as string[]) as readonly AbiEvent[]])) as unknown as Record<EventKind, readonly AbiEvent[]>;
/** topic0 → event kind (Algebra v1 and Slipstream share the V3 signatures; V4 events are emitted by the PoolManager). */
export const GT_TOPICS = Object.fromEntries(ARB_EVENT_KINDS.map((k) => [k, toEventSelector(abiOf[k][0])])) as Record<EventKind, Hex>;
const KIND_BY_TOPIC = new Map(Object.entries(GT_TOPICS).map(([k, t]) => [t, k as EventKind]));
const V4_KINDS = new Set<EventKind>(['swap_v4', 'modify_liquidity_v4']);
const SWAP_KINDS = new Set<EventKind>(['swap_v3', 'swap_pancake', 'swap_v2', 'swap_v4']);
const TRANSFER = topic('Transfer(address,address,uint256)');
const WETH9_DEPOSIT = topic('Deposit(address,uint256)'), WETH9_WITHDRAWAL = topic('Withdrawal(address,uint256)');
const AAVE_FLASH = topic('FlashLoan(address,address,address,uint256,uint8,uint256,uint16)'), BALANCER_FLASH = topic('FlashLoan(address,address,uint256,uint256)'), V3_FLASH = topic('Flash(address,address,uint256,uint256,uint256,uint256)');
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const ZERO = '0x' + '0'.repeat(40);
const LATEST_LAG = 32n; // latest windows end a little behind head so receipts and logs are settled
const hex = (n: bigint) => '0x' + n.toString(16);
const addr = (word: string) => ('0x' + word.slice(-40)).toLowerCase();

/** Wrapped native per network: `transfer` wrappers mint/burn with Transfer logs, WETH9 emits Deposit/Withdrawal. */
const WRAPPED: Record<GtNetwork, { address: string; style: 'transfer' | 'weth9' }> = {
  arbitrum: { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', style: 'transfer' },
  base: { address: '0x4200000000000000000000000000000000000006', style: 'weth9' },
  ethereum: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', style: 'weth9' },
};
type Unit = 'ETH' | 'BTC' | 'USD';
/** Chainlink feeds read at the window's end block; stables = 1. Networks without reviewed feeds are INCONCLUSIVE. */
const PRICES: Partial<Record<GtNetwork, { feeds: Record<'ETH' | 'BTC', string>; assets: Record<string, { unit: Unit; decimals: number }> }>> = {
  arbitrum: {
    feeds: { ETH: '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612', BTC: '0x6ce185860a4963106506c203335a2910413708e9' },
    assets: {
      '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { unit: 'ETH', decimals: 18 },
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { unit: 'USD', decimals: 6 }, '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { unit: 'USD', decimals: 6 },
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { unit: 'USD', decimals: 6 }, '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { unit: 'USD', decimals: 18 },
      '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { unit: 'BTC', decimals: 8 }, '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { unit: 'BTC', decimals: 8 },
    },
  },
};
const FEED_MAX_AGE_S = 86_400n;

// ---------------- pure helpers (exported for fixtures) ----------------
export type GtLog = TopicLog & { transactionIndex: string };
export type DecodedEvent = { kind: EventKind; fields: Record<string, string> };
/** Decodes one pool event by topic0; undefined when the topic is not a dataset event or the log is malformed. */
export function decodePoolEvent(log: TopicLog): DecodedEvent | undefined {
  const kind = KIND_BY_TOPIC.get(String(log.topics?.[0]).toLowerCase() as Hex);
  if (!kind) return undefined;
  try {
    const { args } = decodeEventLog({ abi: abiOf[kind], data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
    const fields = Object.fromEntries(Object.entries(args as unknown as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v.toLowerCase() : String(v)]));
    return { kind, fields };
  } catch { return undefined; /* counted by the caller as MALFORMED_LOG */ }
}
/**
 * Swapper-view [token0, token1] deltas. V2/V3-family events report the pool's view (positive = pool received), so the
 * swapper is the negation; V4 Swap amounts are already the swapper's BalanceDelta (negative = paid in), so the sign is kept.
 */
export function swapperDelta(e: DecodedEvent): [bigint, bigint] {
  const f = (k: string) => BigInt(e.fields[k]);
  switch (e.kind) {
    case 'swap_v3': case 'swap_pancake': return [-f('amount0'), -f('amount1')];
    case 'swap_v2': return [f('amount0Out') - f('amount0In'), f('amount1Out') - f('amount1In')];
    case 'swap_v4': return [f('amount0'), f('amount1')];
    default: throw new ResearchError('INVALID_INPUT', 'Not a swap event.');
  }
}
/** Native ETH and its wrapper are one economic asset inside a cycle (wrap/unwrap legs). */
export const foldNative = (token: string, wrapped: string) => token.toLowerCase() === ZERO ? wrapped : token.toLowerCase();
/** Closed loop: every non-zero net ≥ 0 and at least one > 0 (no external principal). */
export function isClosedLoop(net: Map<string, bigint>) {
  const nz = [...net.values()].filter((v) => v !== 0n);
  return nz.length > 0 && nz.every((v) => v >= 0n);
}

export type GtReceipt = { transactionHash: string; blockHash: string; blockNumber: string; transactionIndex: string; from: string; to: string | null; status?: string; gasUsed: string; effectiveGasPrice: string; logs: Array<{ address: string; topics: string[]; data: string; logIndex?: string }> };
export type Reconciliation = { ok: true; net: Map<string, bigint> } | { ok: false; reason: 'RECEIPT_REORGED' | 'TX_REVERTED' | 'FLASH_RECEIVER_NOT_BENEFICIARY' | 'REALIZED_NOT_POSITIVE' | 'NATIVE_OUTFLOW_UNRECONCILED' };
/**
 * Tier 2 (file 11 #14): beneficiary balance change for {tx.from, tx.to} from the receipt's ERC-20 Transfer logs (plus
 * WETH9 Deposit/Withdrawal). Transfers between beneficiaries cancel; native tx.value always moves from→to, so it nets
 * to zero inside the set. Flash-loan fees are netted by the repayment Transfer the beneficiary makes; a flash loan
 * received by a third contract cannot be reconciled and is rejected. Native swap legs are invisible in logs: a native
 * outflow not covered by a visible unwrap is subtracted from the wrapped asset, a native gain is never credited.
 */
export function reconcileReceipt(args: { receipt: GtReceipt; canonicalHash: string; wrapped: { address: string; style: 'transfer' | 'weth9' }; swapAssets: Set<string>; nativeSwapperDelta: bigint; lenders: Set<string> }): Reconciliation {
  const { receipt: r, wrapped } = args;
  if (String(r.blockHash).toLowerCase() !== args.canonicalHash.toLowerCase()) return { ok: false, reason: 'RECEIPT_REORGED' };
  if (r.status !== undefined && r.status !== '0x1') return { ok: false, reason: 'TX_REVERTED' };
  const ben = new Set([r.from, r.to].filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase()));
  const net = new Map<string, bigint>();
  const add = (token: string, v: bigint) => net.set(token, (net.get(token) ?? 0n) + v);
  let wrappedByBen = 0n, unwrappedByBen = 0n;
  for (const log of r.logs) {
    const t0 = String(log.topics[0]).toLowerCase(), emitter = log.address.toLowerCase();
    if (t0 === TRANSFER && log.topics.length === 3 && /^0x[0-9a-fA-F]{64}$/.test(log.data)) {
      const from = addr(log.topics[1]), to = addr(log.topics[2]), v = BigInt(log.data);
      if (ben.has(to)) add(emitter, v);
      if (ben.has(from)) add(emitter, -v);
      if (emitter === wrapped.address && wrapped.style === 'transfer') { if (from === ZERO && ben.has(to)) wrappedByBen += v; if (to === ZERO && ben.has(from)) unwrappedByBen += v; }
    } else if (wrapped.style === 'weth9' && emitter === wrapped.address && (t0 === WETH9_DEPOSIT || t0 === WETH9_WITHDRAWAL) && log.topics.length === 2) {
      const who = addr(log.topics[1]), v = BigInt(log.data);
      if (!ben.has(who)) continue;
      if (t0 === WETH9_DEPOSIT) { add(emitter, v); wrappedByBen += v; } else { add(emitter, -v); unwrappedByBen += v; }
    } else if ((t0 === AAVE_FLASH || t0 === BALANCER_FLASH || t0 === V3_FLASH) && args.lenders.has(emitter)) {
      const receiver = addr(t0 === V3_FLASH ? log.topics[2] : log.topics[1]);
      if (!ben.has(receiver)) return { ok: false, reason: 'FLASH_RECEIVER_NOT_BENEFICIARY' };
    }
  }
  const nativeEstimate = args.nativeSwapperDelta - wrappedByBen + unwrappedByBen;
  if (nativeEstimate < 0n) { add(wrapped.address, nativeEstimate); if ((net.get(wrapped.address) ?? 0n) < 0n) return { ok: false, reason: 'NATIVE_OUTFLOW_UNRECONCILED' }; }
  for (const [k, v] of net) if (v === 0n) net.delete(k);
  const positive = [...net].some(([k, v]) => v > 0n && args.swapAssets.has(k));
  if (!positive || [...net.values()].some((v) => v < 0n)) return { ok: false, reason: 'REALIZED_NOT_POSITIVE' };
  return { ok: true, net };
}

const MICRO = 1_000_000n;
export function formatUsd(micro: bigint): string {
  const neg = micro < 0n, a = neg ? -micro : micro, f = a % MICRO;
  return (neg ? '-' : '') + (a / MICRO).toString() + (f ? '.' + f.toString().padStart(6, '0').replace(/0+$/, '') : '');
}
const formatGwei = (wei: bigint) => { const f = wei % 1_000_000_000n; return (wei / 1_000_000_000n).toString() + (f ? '.' + f.toString().padStart(9, '0').replace(/0+$/, '') : ''); };

// ---------------- RPC helpers ----------------
const TERMINAL = new Set(['CANCELLED']);
const errorCode = (e: unknown) => e instanceof ResearchError ? e.code : 'INVALID_RESPONSE';
/** Batched reads with per-member outcome and round-level 429/transport backoff; members still missing are returned as undefined. */
async function settledBatch<T>(rpc: JsonClient, calls: Array<{ method: string; params: unknown[] }>, signal: AbortSignal, chunk = 10, rounds = 4): Promise<Array<T | undefined>> {
  const out: Array<T | undefined> = new Array(calls.length).fill(undefined);
  let pending = calls.map((_, i) => i);
  for (let round = 0; round < rounds && pending.length; round++) {
    if (round) await delay(1500 * round, signal);
    const failed: number[] = [];
    for (let at = 0; at < pending.length; at += chunk) {
      const ids = pending.slice(at, at + chunk);
      let raw: unknown;
      try { raw = await rpc.request(ids.map((i) => ({ jsonrpc: '2.0', id: i, ...calls[i] })), signal); }
      catch (e) { if (TERMINAL.has(errorCode(e)) || ['ROUND_DEADLINE', 'RESOLUTION_BUDGET'].includes(errorCode(e))) throw e; failed.push(...ids); continue; }
      const rows = Array.isArray(raw) ? raw as Array<{ id?: number; result?: T | null; error?: unknown }> : [];
      for (const i of ids) { const row = rows.find((x) => x?.id === i); if (row && !row.error && row.result !== undefined && row.result !== null) out[i] = row.result; else failed.push(i); }
    }
    pending = failed;
  }
  return out;
}

// ---------------- measurement ----------------
export type GroundTruthDeps = {
  rpc: JsonClient; budget: RoundBudget; network: GtNetwork; registry: DiscoveryRegistry; deployments: Deployment[];
  initializeIndex?: V4InitializeIndex; locators?: InitializationLocator[];
  /** Shared cache key for a resolved window (arbCacheKey over `groundTruthKeyInputs`). */
  cacheKey: (inputs: Record<string, unknown>) => string;
  /** publishShared; returns the stored artifact identity. */
  publish: (kind: string, cacheKey: string, data: unknown) => Promise<{ id: string; content_hash: string }>;
};
/** Result-affecting inputs of a resolved window; the dispatch dedupe key uses the same shape for explicit windows. */
export const groundTruthKeyInputs = (from: bigint | string, to: bigint | string, include_v4: boolean, min_gross_usd: number) => ({ from_block: from.toString(), to_block: to.toString(), include_v4, min_gross_usd });

type Entry = { log: GtLog; block: bigint; txIndex: number; logIndex: number; kind: EventKind };
type Candidate = { tx: string; block: bigint; txIndex: number; blockHash: string; hops: ArbRecord['hops']; refs: Set<string>; net: Map<string, bigint>; nativeDelta: bigint; grossMicro: bigint; unpriced: boolean };

export async function measureArbGroundTruth(deps: GroundTruthDeps, input: GroundTruthInput): Promise<ArbGroundTruthDocument> {
  const { rpc, budget, network } = deps, signal = budget.signal, chainId = CHAINS[network], wrapped = WRAPPED[network];
  const blockHeader = async (n: bigint) => { const h = await rpc.rpc<Header | null>('eth_getBlockByNumber', [hex(n), false], signal); if (!h?.hash) throw new ResearchError('HEADER_UNAVAILABLE', 'Window header unavailable.', true); return h; };
  let to: bigint;
  if (input.to_block !== undefined) to = BigInt(input.to_block);
  else {
    const head = BigInt(await rpc.rpc<string>('eth_blockNumber', [], signal)) - LATEST_LAG;
    to = input.from_block !== undefined && BigInt(input.from_block) + BigInt(input.window_blocks) - 1n < head ? BigInt(input.from_block) + BigInt(input.window_blocks) - 1n : head;
  }
  const from = input.from_block !== undefined ? BigInt(input.from_block) : (to - BigInt(input.window_blocks) + 1n > 0n ? to - BigInt(input.window_blocks) + 1n : 0n);
  if (to < from) throw new ResearchError('INVALID_INPUT', 'The block window is empty or beyond the chain head.');
  const [fromHeader, toHeader] = [await blockHeader(from), await blockHeader(to)];
  const cacheKey = deps.cacheKey(groundTruthKeyInputs(from, to, input.include_v4, input.min_gross_usd));
  const window = { from_block: from.toString(), to_block: to.toString(), from_hash: fromHeader.hash.toLowerCase(), to_hash: toHeader.hash.toLowerCase() };
  const coverage = { ...emptyCoverage(), archive: 'missing' as 'available' | 'missing', nodes_visited: 0, max_nodes_visited: 0, pools_hydrated: 0, unauthenticated_emitters: 0, unsupported_emitters: 0, unpriced: 0 };
  const excluded: Record<string, number> = {}, bump = (r: Record<string, number>, k: string, n = 1) => { r[k] = (r[k] ?? 0) + n; };
  const warnings: string[] = [], unverified: Record<string, number> = {};
  let reason: string | null = null; const stop = (r: string) => { reason ??= r.slice(0, 160); };
  let scan: TopicScan<GtLog> | undefined;
  const dataset: ArbDatasetEvent[] = [];
  const records: Array<{ record: ArbRecord; surplusMicro: bigint; grossMicro: bigint; gasMicro: bigint | null; netMicro: bigint | null; verified: boolean }> = [];
  const prices: ArbGroundTruthDocument['prices'] = [];
  const totals = { swaps: 0, multi: 0, candidates: 0, priced: 0, surplusMicro: 0n, missing: 0, rejected: 0 };
  let phase = 'ARCHIVE_UNAVAILABLE';
  try {
    // 1. Archive capability probe (file 11 #17): historical eth_call at to − 1000.
    const probeBlock = to > 1000n ? to - 1000n : 0n;
    try {
      // Any decodable word proves historical state is served; the value itself is not compared (Arbitrum's block.number is the L1 block).
      words(await rpc.rpc<string>('eth_call', [{ to: MULTICALL3, data: toFunctionSelector('getBlockNumber()') }, hex(probeBlock)], signal));
      coverage.archive = 'available';
      coverage.source_results.push({ source: 'archive_probe', status: 'SUCCESS', raw_count: 1, valid_count: 1, truncated: false, reason: null });
    } catch (e) {
      if (TERMINAL.has(errorCode(e))) throw e;
      coverage.source_results.push({ source: 'archive_probe', status: 'FAILED', raw_count: 0, valid_count: 0, truncated: false, reason: errorCode(e) });
      throw new ResearchError(errorCode(e), 'Archive probe failed.');
    }
    // 2. Chain-wide topic scan (Swap + Sync/Mint/Burn [+ V4 ModifyLiquidity]) with the completeness ledger.
    phase = 'LOG_SCAN';
    const kinds = ARB_EVENT_KINDS.filter((k) => input.include_v4 || !V4_KINDS.has(k));
    scan = await boundedTopicLogs<GtLog>(rpc, { topics: [kinds.map((k) => GT_TOPICS[k])], from, to }, budget, { pageBlocks: 2000, maxLogsPerPage: 10_000, headerBatch: 10 } /* public gateways 429 on 32-header batches */);
    coverage.source_results.push({ source: 'logs:' + network, status: scan.complete ? 'SUCCESS' : 'FAILED', raw_count: scan.logs.length, valid_count: scan.logs.length, truncated: !scan.complete, reason: scan.failed_ranges[0]?.reason ?? null });
    if (!scan.complete) { coverage.truncated = true; coverage.deferred_counts.FAILED_BLOCKS = scan.failed_ranges.reduce((n, r) => n + Number(BigInt(r.to) - BigInt(r.from) + 1n), 0); stop('SCAN_INCOMPLETE: ' + scan.failed_ranges[0].reason); }
    const entries: Entry[] = [];
    for (const log of scan.logs) {
      const kind = KIND_BY_TOPIC.get(String(log.topics[0]).toLowerCase() as Hex);
      if (!kind || typeof log.transactionIndex !== 'string' || !/^0x[0-9a-f]+$/i.test(log.logIndex) || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash)) { bump(excluded, 'MALFORMED_LOG'); continue; }
      entries.push({ log, block: BigInt(log.blockNumber), txIndex: Number(BigInt(log.transactionIndex)), logIndex: Number(BigInt(log.logIndex)), kind });
    }
    // 3. Emitter authentication (M5b): unauthenticated emitters are counted and excluded.
    phase = 'AUTHENTICATION_UNAVAILABLE';
    const venues = deps.registry.network(network).venues;
    const emitters = [...new Set(entries.map((e) => e.log.address.toLowerCase()))];
    const auth: Map<string, EmitterAuth> = emitters.length ? await new EvmReader(rpc, network, deps.deployments).authenticateEmitters(emitters, toHeader, venues, signal) : new Map();
    coverage.pools_considered = emitters.length;
    for (const [, a] of auth) if (!a.ok) { coverage.unauthenticated_emitters++; bump(excluded, 'EMITTER_' + a.reason); }
    // 4. V4 pool keys (M5b index) for swap/modify events on authenticated managers.
    phase = 'V4_RESOLUTION_UNAVAILABLE';
    const v4Keys = new Map<string, { currency0: string; currency1: string }>();
    const v4Ids = new Map<string, Set<string>>();
    for (const e of entries) if (V4_KINDS.has(e.kind) && auth.get(e.log.address.toLowerCase())?.ok) { const m = e.log.address.toLowerCase(); (v4Ids.get(m) ?? v4Ids.set(m, new Set()).get(m)!).add(String(e.log.topics[1]).toLowerCase()); }
    for (const [manager, ids] of v4Ids) {
      if (!deps.initializeIndex) { coverage.unsupported_emitters += ids.size; bump(excluded, 'V4_INDEX_UNCONFIGURED', ids.size); continue; }
      const venue = venues.find((v) => v.family === 'V4' && v.factory === manager);
      const start = venue?.initialization_block !== undefined ? BigInt(venue.initialization_block) : (to > 9999n ? to - 9999n : 0n);
      const resolved = await resolveV4PoolKeys({ rpc, index: deps.initializeIndex, budget, start, locators: deps.locators?.filter((l) => l.network === network) }, chainId, manager, [...ids], toHeader);
      for (const id of ids) { const r = resolved.get(id); if (r?.ok) v4Keys.set(id, { currency0: r.entry.currency0, currency1: r.entry.currency1 }); else { coverage.unsupported_emitters++; bump(excluded, 'V4_' + (r?.ok === false ? r.code : 'UNRESOLVED_POOL_KEY')); } }
    }
    // 5. Complete ordered event dataset (file 11 #17) — every authenticated event, keyed (block, tx_index, log_index).
    const poolRefOf = (e: Entry) => V4_KINDS.has(e.kind) ? String(e.log.topics[1]).toLowerCase() : e.log.address.toLowerCase();
    const decoded = new Map<Entry, DecodedEvent>();
    const badTx = new Set<string>();
    for (const e of entries) {
      const a = auth.get(e.log.address.toLowerCase());
      if (!a?.ok) { if (SWAP_KINDS.has(e.kind)) badTx.add(e.log.transactionHash.toLowerCase()); continue; }
      const d = decodePoolEvent(e.log);
      if (!d) { bump(excluded, 'MALFORMED_LOG'); if (SWAP_KINDS.has(e.kind)) badTx.add(e.log.transactionHash.toLowerCase()); continue; }
      decoded.set(e, d);
      dataset.push({ block: e.block.toString(), tx_index: e.txIndex, log_index: e.logIndex, tx: e.log.transactionHash.toLowerCase(), block_hash: e.log.blockHash.toLowerCase(), emitter: e.log.address.toLowerCase(), pool_ref: poolRefOf(e), venue_id: a.venue_id, kind: d.kind, fields: d.fields });
    }
    dataset.sort((a, b) => a.block === b.block ? a.tx_index - b.tx_index || a.log_index - b.log_index : BigInt(a.block) < BigInt(b.block) ? -1 : 1);
    coverage.pools_watched = new Set(dataset.map((d) => d.pool_ref)).size;
    // 6. Tier 1 — swap-surplus candidates (prototype method, authenticated legs only).
    phase = 'CANDIDATES';
    const swapsByTx = new Map<string, Entry[]>();
    for (const [e, d] of decoded) if (SWAP_KINDS.has(d.kind)) { totals.swaps++; const k = e.log.transactionHash.toLowerCase(); (swapsByTx.get(k) ?? swapsByTx.set(k, []).get(k)!).push(e); }
    const config = PRICES[network];
    if (!config) stop('PRICE_FEEDS_UNCONFIGURED');
    // Prices first: candidate gross needs them and the min_gross_usd filter avoids receipt reads for dropped candidates.
    phase = 'PRICE_FEED_UNAVAILABLE';
    const unitPrice = new Map<Unit, bigint>([['USD', 100_000_000n]]);
    if (config) for (const [unit, feed] of Object.entries(config.feeds) as Array<['ETH' | 'BTC', string]>) {
      try {
        const w = words(await rpc.rpc<string>('eth_call', [{ to: feed, data: toFunctionSelector('latestRoundData()') }, { blockHash: toHeader.hash, requireCanonical: true }], signal));
        const answer = BigInt.asIntN(256, w[1]), updatedAt = w[3];
        if (answer <= 0n || updatedAt + FEED_MAX_AGE_S < BigInt(toHeader.timestamp)) { stop('PRICE_FEED_STALE: ' + unit); continue; }
        unitPrice.set(unit, answer);
        prices.push({ asset: assetId(network, Object.entries(config.assets).find(([, a]) => a.unit === unit)![0]), usd: formatUsd(answer / 100n), source: 'chainlink:' + feed + '@' + to });
      } catch (e) { if (TERMINAL.has(errorCode(e))) throw e; stop('PRICE_FEED_UNAVAILABLE: ' + unit + ' ' + errorCode(e)); }
    }
    const valueMicro = (token: string, raw: bigint): bigint | null => {
      const a = config?.assets[token]; const p = a && unitPrice.get(a.unit);
      return a && p !== undefined ? raw * p * MICRO / (10n ** BigInt(a.decimals) * 100_000_000n) : null;
    };
    const candidates: Candidate[] = [];
    // Multi-pool is judged on every Swap emitter in the tx, so a loop through an unauthenticated pool is excluded, not shortened.
    const allRefs = new Map<string, Set<string>>();
    for (const e of entries) if (SWAP_KINDS.has(e.kind)) { const k = e.log.transactionHash.toLowerCase(); (allRefs.get(k) ?? allRefs.set(k, new Set()).get(k)!).add(poolRefOf(e)); }
    for (const [tx, refsAll] of allRefs) {
      if (refsAll.size < 2) continue;
      totals.multi++;
      if (badTx.has(tx)) { bump(excluded, 'TX_WITH_UNAUTHENTICATED_SWAP'); continue; }
      const legs = swapsByTx.get(tx) ?? [];
      const refs = new Set(legs.map(poolRefOf));
      legs.sort((a, b) => a.logIndex - b.logIndex); // several logs in one tx are applied in log order
      if (legs.length > 16) { bump(excluded, 'TOO_MANY_HOPS'); continue; }
      const net = new Map<string, bigint>(); let nativeDelta = 0n, ok = true; const hops: ArbRecord['hops'] = [];
      for (const e of legs) {
        const d = decoded.get(e)!, ref = poolRefOf(e), a = auth.get(e.log.address.toLowerCase()) as Extract<EmitterAuth, { ok: true }>;
        const tokens = d.kind === 'swap_v4' ? (v4Keys.get(ref) ? [v4Keys.get(ref)!.currency0, v4Keys.get(ref)!.currency1] : undefined) : a.tokens;
        if (!tokens) { ok = false; bump(excluded, d.kind === 'swap_v4' ? 'TX_WITH_UNRESOLVED_V4' : 'TX_WITH_UNKNOWN_TOKENS'); break; }
        const delta = swapperDelta(d);
        tokens.forEach((t, i) => { if (t.toLowerCase() === ZERO) nativeDelta += delta[i]; const k = foldNative(t, wrapped.address); net.set(k, (net.get(k) ?? 0n) + delta[i]); });
        hops.push({ pool_ref: ref, venue_id: a.venue_id, delta: [delta[0].toString(), delta[1].toString()] });
      }
      if (!ok || !isClosedLoop(net)) continue;
      for (const [k, v] of net) if (v === 0n) net.delete(k);
      let grossMicro = 0n, unpriced = false;
      for (const [k, v] of net) { const m = valueMicro(k, v); if (m === null) unpriced = true; else grossMicro += m; }
      const first = legs[0];
      candidates.push({ tx, block: first.block, txIndex: first.txIndex, blockHash: first.log.blockHash.toLowerCase(), hops, refs, net, nativeDelta, grossMicro, unpriced });
    }
    const kept = candidates.filter((c) => Number(c.grossMicro) / 1e6 >= input.min_gross_usd);
    totals.candidates = kept.length; totals.priced = kept.filter((c) => c.grossMicro > 0n).length; totals.surplusMicro = kept.reduce((s, c) => s + c.grossMicro, 0n);
    coverage.unpriced = kept.filter((c) => c.unpriced).length;
    coverage.tokens_considered = new Set(kept.flatMap((c) => [...c.net.keys()])).size;
    // 7. Receipts (gas, from/to, tier 2) and block base fees, batched with 429 backoff.
    phase = 'RECEIPTS_UNAVAILABLE';
    const receipts = await settledBatch<GtReceipt>(rpc, kept.map((c) => ({ method: 'eth_getTransactionReceipt', params: [c.tx] })), signal);
    const blocks = [...new Set(kept.map((c) => c.block))];
    const headers = await settledBatch<Header>(rpc, blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] })), signal);
    const baseFee = new Map(blocks.map((b, i) => [b, headers[i]?.baseFeePerGas !== undefined ? BigInt(headers[i]!.baseFeePerGas!) : undefined]));
    coverage.source_results.push({ source: 'receipts', status: receipts.every(Boolean) ? 'SUCCESS' : 'FAILED', raw_count: kept.length, valid_count: receipts.filter(Boolean).length, truncated: !receipts.every(Boolean), reason: receipts.every(Boolean) ? null : 'RECEIPT_UNAVAILABLE' });
    const lenders = new Set([...deps.registry.network(network).lenders.map((l) => l.address), ...[...auth].filter(([, a]) => a.ok && a.family !== 'V4').map(([k]) => k)]);
    const eth = unitPrice.get('ETH');
    const eventsByBlock = new Map<string, ArbDatasetEvent[]>();
    for (const d of dataset) (eventsByBlock.get(d.block) ?? eventsByBlock.set(d.block, []).get(d.block)!).push(d);
    kept.forEach((c, i) => {
      const r = receipts[i];
      if (!r) { totals.missing++; return; }
      if (!r.to) { bump(excluded, 'CONTRACT_CREATION'); return; }
      if (String(r.blockHash).toLowerCase() !== c.blockHash || BigInt(r.transactionIndex) !== BigInt(c.txIndex)) { totals.rejected++; bump(unverified, 'RECEIPT_REORGED'); return; }
      const gasWei = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
      const gasMicro = eth === undefined ? null : gasWei * eth * MICRO / (10n ** 18n * 100_000_000n);
      const fee = baseFee.get(c.block);
      const rec = reconcileReceipt({ receipt: r, canonicalHash: c.blockHash, wrapped, swapAssets: new Set(c.net.keys()), nativeSwapperDelta: c.nativeDelta, lenders });
      if (!rec.ok) bump(unverified, rec.reason);
      const verifiedNet = rec.ok ? rec.net : null;
      let gross = c.grossMicro;
      if (verifiedNet) { gross = 0n; for (const [k, v] of verifiedNet) { const m = valueMicro(k, v); if (m !== null) gross += m; } }
      const prior = (eventsByBlock.get(c.block.toString()) ?? []).filter((d) => d.tx_index < c.txIndex && c.refs.has(d.pool_ref));
      const triggerIndex = prior.length ? Math.max(...prior.map((d) => d.tx_index)) : -1;
      const triggerEvents = prior.filter((d) => d.tx_index === triggerIndex);
      const units = new Set([...(verifiedNet ?? c.net).keys()].map((k) => config?.assets[k]?.unit).filter(Boolean));
      const record = arbRecordSchema.parse({
        tier: verifiedNet ? 'verified_realized' : 'swap_surplus_candidate', tx: c.tx, block: c.block.toString(), tx_index: c.txIndex,
        to: r.to.toLowerCase(), from: r.from.toLowerCase(), hops: c.hops,
        net_by_asset: Object.fromEntries([...(verifiedNet ?? c.net)].map(([k, v]) => [assetId(network, k), v.toString()])),
        gross_usd: formatUsd(gross), gas_usd: gasMicro === null ? null : formatUsd(gasMicro), net_usd: gasMicro === null ? null : formatUsd(gross - gasMicro),
        priority_gwei: fee === undefined ? null : formatGwei(BigInt(r.effectiveGasPrice) - fee > 0n ? BigInt(r.effectiveGasPrice) - fee : 0n), express_lane: null,
        trigger: triggerEvents.length ? { tx: triggerEvents[0].tx, tx_index: triggerIndex, shared_pools: [...new Set(triggerEvents.map((d) => d.pool_ref))].slice(0, 16) } : null,
        cycle_id: null, price_sources: [...[...units].map((u) => u === 'USD' ? 'stable:1' : 'chainlink:' + u + '-usd@' + to), ...(c.unpriced ? ['unpriced-assets-excluded'] : [])].slice(0, 8),
      });
      records.push({ record, surplusMicro: c.grossMicro, grossMicro: gross, gasMicro, netMicro: gasMicro === null ? null : gross - gasMicro, verified: Boolean(verifiedNet) });
    });
    if (totals.missing) stop('RECEIPTS_MISSING: ' + totals.missing);
    if (totals.rejected) stop('RECEIPT_REORGED: ' + totals.rejected);
  } catch (e) {
    if (TERMINAL.has(errorCode(e)) && budget.remainingMs() > 0) throw e; // job cancellation; a spent round deadline is INCONCLUSIVE
    stop(phase + ': ' + (TERMINAL.has(errorCode(e)) ? 'ROUND_DEADLINE' : errorCode(e)));
  }
  // 8. Publish the dataset pages, then assemble the document.
  const pages: ArbGroundTruthDocument['dataset']['pages'] = [];
  const pageCount = Math.ceil(dataset.length / ARB_DATASET_PAGE_EVENTS);
  for (let page = 0; page < pageCount; page++) {
    const events = dataset.slice(page * ARB_DATASET_PAGE_EVENTS, (page + 1) * ARB_DATASET_PAGE_EVENTS);
    const doc = arbEventDatasetPageSchema.parse({ schema_version: 'flashloan.arb.event_dataset.v1', network, chain_id: chainId, window, ordering: 'block,tx_index,log_index', page, pages: pageCount, events });
    const pageKey = hash({ ground_truth: cacheKey, page });
    const stored = await deps.publish('arb_event_dataset', pageKey, doc);
    pages.push({ artifact_id: stored.id, cache_key: pageKey, content_hash: stored.content_hash, events: events.length });
  }
  records.sort((a, b) => a.grossMicro === b.grossMicro ? a.record.tx.localeCompare(b.record.tx) : a.grossMicro > b.grossMicro ? -1 : 1);
  const bots = new Map<string, { arbs: number; verified: number; gross: bigint; net: bigint | null }>();
  for (const r of records) { const b = bots.get(r.record.to) ?? { arbs: 0, verified: 0, gross: 0n, net: 0n }; b.arbs++; b.verified += r.verified ? 1 : 0; b.gross += r.grossMicro; b.net = b.net === null || r.netMicro === null ? null : b.net + r.netMicro; bots.set(r.record.to, b); }
  const bucket = { '<0.05': 0, '0.05-0.5': 0, '0.5-5': 0, '>5': 0 };
  for (const r of records) { const g = r.grossMicro; bucket[g < 50_000n ? '<0.05' : g < 500_000n ? '0.05-0.5' : g < 5_000_000n ? '0.5-5' : '>5']++; }
  const idx = records.map((r) => r.record.tx_index).sort((a, b) => a - b);
  const verified = records.filter((r) => r.verified);
  const byKind: Record<string, number> = {}; for (const d of dataset) bump(byKind, d.kind);
  coverage.excluded_counts = excluded;
  if (!input.include_v4) warnings.push('V4 excluded by request: tier-1 nets omit V4 legs; this never implies V4 can only raise totals.');
  warnings.push('Tier 1 swap_surplus_candidate is swap-delta netting; only verified_realized reconciles beneficiary balances (file 11 #14).');
  const outcome = reason !== null ? 'INCONCLUSIVE' : records.length ? 'SUCCESS' : 'EMPTY';
  return arbGroundTruthDocumentSchema.parse({
    schema_version: 'flashloan.arb.ground_truth.v1', network, chain_id: chainId, window, records: records.map((r) => r.record), coverage, warnings,
    cache_key: cacheKey, registry_version: deps.registry.version, outcome, reason, inputs: { include_v4: input.include_v4, min_gross_usd: input.min_gross_usd },
    totals: { events: dataset.length, swaps: totals.swaps, multi_pool_txs: totals.multi, candidates: totals.candidates, candidates_priced: totals.priced, verified: verified.length,
      candidate_gross_usd: formatUsd(totals.surplusMicro), verified_gross_usd: formatUsd(verified.reduce((s, r) => s + r.grossMicro, 0n)),
      gas_usd: formatUsd(records.reduce((s, r) => s + (r.gasMicro ?? 0n), 0n)), verified_net_usd: formatUsd(verified.reduce((s, r) => s + (r.netMicro ?? 0n), 0n)),
      receipts_missing: totals.missing, receipts_rejected: totals.rejected },
    by_bot: [...bots].sort(([a, x], [b, y]) => y.arbs - x.arbs || (y.gross > x.gross ? 1 : y.gross < x.gross ? -1 : a.localeCompare(b))).slice(0, 50).map(([to, b]) => ({ to, arbs: b.arbs, verified: b.verified, gross_usd: formatUsd(b.gross), net_usd: b.net === null ? null : formatUsd(b.net) })),
    by_bucket: bucket, tx_index: { p50: idx.length ? idx[Math.floor((idx.length - 1) / 2)] : null, share_le_3: idx.length ? idx.filter((i) => i <= 3).length / idx.length : null },
    prices, unverified_reasons: unverified,
    dataset: { complete: Boolean(scan?.complete) && !/^(AUTHENTICATION|V4_RESOLUTION|LOG_SCAN)/.test(reason ?? ''), total_events: dataset.length, by_kind: byKind, pages },
  });
}
