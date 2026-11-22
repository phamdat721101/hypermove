// Deterministic chain fixture for PRD-C ground truth (tests/flashloan-arb-ground-truth.test.ts).
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, parseAbi, parseAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { DiscoveryRegistry } from '../../src/lib/mcp/flashloan/discovery-registry';
import { canonicalPoolId } from '../../src/lib/mcp/flashloan/pool-resolution';
import type { V4InitEntry } from '../../src/lib/mcp/flashloan/storage';

export const H = (n: bigint | number) => '0x' + BigInt(n).toString(16).padStart(64, '0');
export const CODE = '0x6000', CODE_HASH = keccak256(CODE);
export const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', USDT = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', NATIVE = '0x' + '0'.repeat(40);
export const F3 = '0x' + 'f3'.repeat(20), F2 = '0x' + 'f2'.repeat(20), MANAGER = '0x' + '44'.repeat(20), VIEW = '0x' + '45'.repeat(20), VAULT = '0xba12222222228d8ba445958a75a0704d566bf2c8';
export const P1 = '0x' + 'a1'.repeat(20), P2 = '0x' + 'a2'.repeat(20), P3 = '0x' + 'a3'.repeat(20), FORGED = '0x' + 'fe'.repeat(20);
export const EOA = '0x' + 'e0'.repeat(20), BOT = '0x' + 'b0'.repeat(20), USER = '0x' + 'c0'.repeat(20);
export const ETH_FEED = '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612', BTC_FEED = '0x6ce185860a4963106506c203335a2910413708e9';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
export const V4_KEY = { currency0: NATIVE, currency1: USDC, fee: 500, tickSpacing: 10, hooks: NATIVE };
export const V4_ID = canonicalPoolId(V4_KEY).toLowerCase();
export const WINDOW = { from: 1000, to: 2000 };
const TS = 1_700_000_000;

export const registry = new DiscoveryRegistry({ networks: { arbitrum: {
  venues: [
    { id: 'fx-v3', provider_ids: [], family: 'V3', factory: F3, factory_code_hash: CODE_HASH, pool_lookup: 'getPoolFee', quoter_kind: 'onchain_quoter', cpmm: true, status: 'reviewed' },
    { id: 'fx-v2', provider_ids: [], family: 'V2', factory: F2, factory_code_hash: CODE_HASH, pool_lookup: 'getPair', quoter_kind: 'onchain_quoter', cpmm: true, status: 'reviewed' },
    { id: 'fx-v4', provider_ids: [], family: 'V4', factory: MANAGER, factory_code_hash: CODE_HASH, state_view: VIEW, state_view_code_hash: CODE_HASH, quoter_kind: 'v4_state_quoter', cpmm: true, status: 'reviewed' },
  ],
  lenders: [{ id: 'balancer-v2', kind: 'balancer_v2', address: VAULT, code_hash: CODE_HASH, fee_bps: 0, callback: 'receiveFlashLoan', assets: 'any' }],
} } });
export const v4Entry: V4InitEntry = { chain_id: 42161, manager: MANAGER, pool_id: V4_ID, ...V4_KEY, block_number: '900', block_hash: H(900), tx_hash: H(9001), log_index: 0 };

const abi = parseAbi([
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event FlashLoan(address indexed recipient,address indexed token,uint256 amount,uint256 feeAmount)',
  'event Sync(uint112 reserve0,uint112 reserve1)',
]);
const v2Swap = parseAbi(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const v4Swap = parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']);
const aggregate3 = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);

export type FxEvent =
  | { kind: 'v3'; pool: string; a0: bigint; a1: bigint }
  | { kind: 'v2'; pool: string; in0: bigint; in1: bigint; out0: bigint; out1: bigint }
  | { kind: 'v4'; a0: bigint; a1: bigint }
  | { kind: 'sync'; pool: string }
  | { kind: 'transfer'; token: string; from: string; to: string; value: bigint }
  | { kind: 'flash'; recipient: string; token: string; amount: bigint; fee: bigint };
export type FxTx = { hash: string; block: number; index: number; from: string; to: string; events: FxEvent[]; logOrder?: 'reverse' };
type Log = { address: string; topics: string[]; data: string; blockNumber: string; blockHash: string; transactionHash: string; transactionIndex: string; logIndex: string };

function encode(e: FxEvent, sender: string): { address: string; topics: string[]; data: string } {
  switch (e.kind) {
    case 'v3': return { address: e.pool, topics: encodeEventTopics({ abi, eventName: 'Swap', args: { sender: sender as Hex, recipient: sender as Hex } }) as string[], data: encodeAbiParameters(parseAbiParameters('int256,int256,uint160,uint128,int24'), [e.a0, e.a1, 1n << 96n, 10n ** 18n, 0]) };
    case 'v2': return { address: e.pool, topics: encodeEventTopics({ abi: v2Swap, eventName: 'Swap', args: { sender: sender as Hex, to: sender as Hex } }) as string[], data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), [e.in0, e.in1, e.out0, e.out1]) };
    case 'v4': return { address: MANAGER, topics: encodeEventTopics({ abi: v4Swap, eventName: 'Swap', args: { id: V4_ID as Hex, sender: sender as Hex } }) as string[], data: encodeAbiParameters(parseAbiParameters('int128,int128,uint160,uint128,int24,uint24'), [e.a0, e.a1, 1n << 96n, 10n ** 18n, 0, 500]) };
    case 'sync': return { address: e.pool, topics: encodeEventTopics({ abi, eventName: 'Sync' }) as string[], data: encodeAbiParameters(parseAbiParameters('uint112,uint112'), [10n ** 12n, 10n ** 12n]) };
    case 'transfer': return { address: e.token, topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from: e.from as Hex, to: e.to as Hex } }) as string[], data: encodeAbiParameters(parseAbiParameters('uint256'), [e.value]) };
    case 'flash': return { address: VAULT, topics: encodeEventTopics({ abi, eventName: 'FlashLoan', args: { recipient: e.recipient as Hex, token: e.token as Hex } }) as string[], data: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [e.amount, e.fee]) };
  }
}
const word = (v: string | bigint) => encodeAbiParameters(parseAbiParameters('uint256'), [BigInt(v)]);
const POOLS: Record<string, { t0: string; t1: string; factory: string; fee?: number }> = { [P1]: { t0: WETH, t1: USDC, factory: F3, fee: 500 }, [P2]: { t0: WETH, t1: USDC, factory: F3, fee: 3000 }, [P3]: { t0: USDC, t1: USDT, factory: F2 }, [FORGED]: { t0: WETH, t1: USDC, factory: F3, fee: 100 } };
function poolAnswer(to: string, data: Hex): Hex | undefined {
  const sel = data.slice(0, 10);
  if (to === F3 && sel === toFunctionSelector('getPool(address,address,uint24)')) { const [, , fee] = decodeAbiParameters(parseAbiParameters('address,address,uint24'), ('0x' + data.slice(10)) as Hex); return word(fee === 500 ? P1 : fee === 3000 ? P2 : NATIVE); }
  if (to === F2 && sel === toFunctionSelector('getPair(address,address)')) return word(P3);
  const p = POOLS[to]; if (!p) return undefined;
  const table: Record<string, Hex | undefined> = { [toFunctionSelector('token0()')]: word(p.t0), [toFunctionSelector('token1()')]: word(p.t1), [toFunctionSelector('factory()')]: word(p.factory), [toFunctionSelector('fee()')]: p.fee === undefined ? undefined : word(BigInt(p.fee)) };
  return table[sel];
}

export type ChainOptions = { archivePruned?: boolean; reorgReceipts?: string[]; dropReceipts?: string[] };
/** JSON-RPC fake over a set of transactions: logs, receipts, headers, Multicall3 auth reads, Chainlink feeds and the archive probe. */
export function fakeChain(txs: FxTx[], options: ChainOptions = {}) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const receipts = new Map<string, unknown>(); const poolLogs: Log[] = [];
  const byBlock = new Map<number, number>();
  for (const tx of [...txs].sort((a, b) => a.block - b.block || a.index - b.index)) {
    const logs = tx.events.map((e) => { const n = byBlock.get(tx.block) ?? 0; byBlock.set(tx.block, n + 1); return { ...encode(e, tx.to), blockNumber: '0x' + tx.block.toString(16), blockHash: H(tx.block), transactionHash: tx.hash, transactionIndex: '0x' + tx.index.toString(16), logIndex: '0x' + n.toString(16) }; });
    const pool = logs.filter((_, i) => ['v3', 'v2', 'v4', 'sync'].includes(tx.events[i].kind));
    poolLogs.push(...(tx.logOrder === 'reverse' ? [...pool].reverse() : pool));
    receipts.set(tx.hash, { transactionHash: tx.hash, blockHash: options.reorgReceipts?.includes(tx.hash) ? H(777777) : H(tx.block), blockNumber: '0x' + tx.block.toString(16), transactionIndex: '0x' + tx.index.toString(16), from: tx.from, to: tx.to, status: '0x1', gasUsed: '0xf4240', effectiveGasPrice: '0x1312d00', logs });
  }
  const handler = (method: string, params: unknown[]): unknown => {
    if (method === 'eth_blockNumber') return '0x' + (WINDOW.to + 100).toString(16);
    if (method === 'eth_getBlockByNumber') { const n = Number(BigInt(params[0] as string)); return { number: params[0], hash: H(n), parentHash: H(n - 1), timestamp: '0x' + (TS + n).toString(16), gasLimit: '0x1', miner: NATIVE, baseFeePerGas: '0x989680' }; }
    if (method === 'eth_getCode') return CODE;
    if (method === 'eth_getLogs') {
      const f = params[0] as { fromBlock: string; toBlock: string; topics: string[][] };
      const lo = Number(BigInt(f.fromBlock)), hi = Number(BigInt(f.toBlock));
      return poolLogs.filter((l) => Number(BigInt(l.blockNumber)) >= lo && Number(BigInt(l.blockNumber)) <= hi && (!f.topics?.[0] || f.topics[0].includes(l.topics[0])));
    }
    if (method === 'eth_getTransactionReceipt') return options.dropReceipts?.includes(params[0] as string) ? null : receipts.get(params[0] as string) ?? null;
    if (method === 'eth_call') {
      const call = params[0] as { to: string; data: Hex };
      if (call.to === MULTICALL3 && typeof params[1] === 'string') return options.archivePruned ? { error: { code: -32000, message: 'missing trie node' } } : word(BigInt(params[1]));
      if (call.to === MULTICALL3) {
        const members = decodeFunctionData({ abi: aggregate3, data: call.data }).args[0];
        return encodeFunctionResult({ abi: aggregate3, functionName: 'aggregate3', result: members.map((m) => { const v = poolAnswer(m.target.toLowerCase(), m.callData); return v ? { success: true, returnData: v } : { success: false, returnData: '0x' as Hex }; }) });
      }
      if (call.to === ETH_FEED || call.to === BTC_FEED) return encodeAbiParameters(parseAbiParameters('uint80,int256,uint256,uint256,uint80'), [1n, call.to === ETH_FEED ? 2000n * 10n ** 8n : 60000n * 10n ** 8n, BigInt(TS), BigInt(TS + WINDOW.to), 1n]);
    }
    throw new Error('unexpected ' + method);
  };
  const answer = (r: { id: number; method: string; params: unknown[] }) => { calls.push(r); try { const v = handler(r.method, r.params) as { error?: unknown }; return v && typeof v === 'object' && 'error' in v ? { jsonrpc: '2.0', id: r.id, error: v.error } : { jsonrpc: '2.0', id: r.id, result: v }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: String(e) } }; } };
  const fetcher: typeof fetch = async (_url, init) => { const body = JSON.parse(String(init?.body)); return Response.json(Array.isArray(body) ? body.map(answer) : answer(body)); };
  return { fetcher, calls, count: (m: string) => calls.filter((c) => c.method === m).length };
}

const E18 = 10n ** 18n, E6 = 10n ** 6n;
/** The adversarial scenario set; each tx hash encodes its purpose in the leading byte. */
export const tx = {
  trigger: H(0x10), loop: H(0x11), aggregator: H(0x12), forged: H(0x13), lenderFee: H(0x14), wrapLoop: H(0x15), nativeKept: H(0x16),
};
export function scenario(): FxTx[] {
  return [
    // User swap on P1 that precedes (and triggers) the closed loop below.
    { hash: tx.trigger, block: 1500, index: 2, from: USER, to: USER, events: [{ kind: 'v3', pool: P1, a0: -E18 / 10n, a1: 200n * E6 }] },
    // 2-pool closed loop, logs served in reverse order: sell 1 WETH on P1, buy 1.01 WETH on P2 → +0.01 WETH.
    { hash: tx.loop, block: 1500, index: 5, from: EOA, to: BOT, logOrder: 'reverse', events: [
      { kind: 'transfer', token: WETH, from: BOT, to: P1, value: E18 }, { kind: 'transfer', token: USDC, from: P1, to: BOT, value: 2000n * E6 }, { kind: 'v3', pool: P1, a0: E18, a1: -2000n * E6 },
      { kind: 'transfer', token: USDC, from: BOT, to: P2, value: 2000n * E6 }, { kind: 'transfer', token: WETH, from: P2, to: BOT, value: 101n * E18 / 100n }, { kind: 'v3', pool: P2, a0: -101n * E18 / 100n, a1: 2000n * E6 }] },
    // Aggregator A→B→C: WETH → USDC (P1) → USDT (P3, V2) — pays WETH in, no closed loop.
    { hash: tx.aggregator, block: 1600, index: 1, from: USER, to: USER, events: [{ kind: 'v3', pool: P1, a0: E18, a1: -2000n * E6 }, { kind: 'sync', pool: P3 }, { kind: 'v2', pool: P3, in0: 2000n * E6, in1: 0n, out0: 0n, out1: 1999n * E6 }] },
    // A loop through a forged emitter that implements token0/token1/factory but is not registered by the factory.
    { hash: tx.forged, block: 1700, index: 1, from: EOA, to: BOT, events: [{ kind: 'v3', pool: P1, a0: E18, a1: -2000n * E6 }, { kind: 'v3', pool: FORGED, a0: -2n * E18, a1: 2000n * E6 }] },
    // #10 flash-loan fee consumes the surplus: +0.5 USDC swap surplus, 1 USDC Balancer fee.
    { hash: tx.lenderFee, block: 1800, index: 3, from: EOA, to: BOT, events: [
      { kind: 'flash', recipient: BOT, token: USDC, amount: 2000n * E6, fee: E6 }, { kind: 'transfer', token: USDC, from: VAULT, to: BOT, value: 2000n * E6 },
      { kind: 'transfer', token: USDC, from: BOT, to: P1, value: 2000n * E6 }, { kind: 'transfer', token: WETH, from: P1, to: BOT, value: E18 }, { kind: 'v3', pool: P1, a0: -E18, a1: 2000n * E6 },
      { kind: 'transfer', token: WETH, from: BOT, to: P2, value: E18 }, { kind: 'transfer', token: USDC, from: P2, to: BOT, value: 20005n * E6 / 10n }, { kind: 'v3', pool: P2, a0: E18, a1: -20005n * E6 / 10n },
      { kind: 'transfer', token: USDC, from: BOT, to: VAULT, value: 2001n * E6 }] },
    // #11 native ETH inside the cycle: sell 1 WETH on P1, buy 1.01 native ETH on V4 (swapper delta +), then wrap it.
    { hash: tx.wrapLoop, block: 1900, index: 1, from: EOA, to: BOT, events: [
      { kind: 'transfer', token: WETH, from: BOT, to: P1, value: E18 }, { kind: 'transfer', token: USDC, from: P1, to: BOT, value: 2000n * E6 }, { kind: 'v3', pool: P1, a0: E18, a1: -2000n * E6 },
      { kind: 'transfer', token: USDC, from: BOT, to: MANAGER, value: 2000n * E6 }, { kind: 'v4', a0: 101n * E18 / 100n, a1: -2000n * E6 },
      { kind: 'transfer', token: WETH, from: NATIVE, to: BOT, value: 101n * E18 / 100n }] },
    // Same cycle but the native ETH is kept unwrapped: invisible in logs, so it never counts as realized.
    { hash: tx.nativeKept, block: 1950, index: 1, from: EOA, to: BOT, events: [
      { kind: 'transfer', token: WETH, from: BOT, to: P1, value: E18 }, { kind: 'transfer', token: USDC, from: P1, to: BOT, value: 2000n * E6 }, { kind: 'v3', pool: P1, a0: E18, a1: -2000n * E6 },
      { kind: 'transfer', token: USDC, from: BOT, to: MANAGER, value: 2000n * E6 }, { kind: 'v4', a0: 101n * E18 / 100n, a1: -2000n * E6 }] },
  ];
}
