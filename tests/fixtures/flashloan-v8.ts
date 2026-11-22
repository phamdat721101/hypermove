import { keccak256, toFunctionSelector, encodeEventTopics, encodeAbiParameters, parseAbi, parseAbiParameters, type Hex } from 'viem';
import { DiscoveryRegistry } from '../../src/lib/mcp/flashloan/discovery-registry';
import { canonicalPoolId } from '../../src/lib/mcp/flashloan/pool-resolution';
import { assetId } from '../../src/lib/mcp/flashloan/v8-contracts';

export const A8 = '0x' + '1'.repeat(40), Q8 = '0x' + '2'.repeat(40), P8 = '0x' + '3'.repeat(40), P82 = '0x' + '4'.repeat(40), F8 = '0x' + '5'.repeat(40), F82 = '0x' + '6'.repeat(40), VIEW8 = '0x' + '7'.repeat(40), HOOK8 = '0x' + '8'.repeat(40);
export const BLOCK8 = '0x' + 'a'.repeat(64), CODE8 = '0x6000' as Hex;
export const words8 = (...values: Array<bigint | number | string>) => '0x' + values.map((v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0')).join('');
export type FixtureFault = 'none' | 'zero' | 'state' | 'code' | 'reorg' | 'no-price' | 'wrong-currency' | 'wrong-chain' | 'gecko' | 'bad-init' | 'bad-batch' | 'final-unavailable';
export function fixtureV8(options: { fault?: FixtureFault; v4?: boolean; dynamic?: boolean; hook?: boolean; network?: 'base' | 'robinhood'; reverse?: boolean; nativeOnly?: boolean; cl?: 'V3' | 'ALGEBRA' | 'AERO_CL' } = {}) {
  const network = options.network ?? 'base', chain = network === 'base' ? 8453 : 4663, fault = options.fault ?? 'none';
  const key = { currency0: A8, currency1: Q8, fee: options.dynamic ? 0x800000 : 3000, tickSpacing: 60, hooks: options.hook ? HOOK8 : '0x' + '0'.repeat(40) };
  const poolId = canonicalPoolId(key), calls: Array<{ method: string; params: unknown[] }> = [];
  const venue = (id: string, factory: string) => ({ id, provider_ids: [id], family: options.v4 ? 'V4' : options.cl === 'ALGEBRA' ? 'ALGEBRA' : options.cl ? 'V3' : 'V2', ...(options.cl === 'AERO_CL' ? { pool_lookup: 'getPoolSpacing' } : {}), factory, factory_code_hash: keccak256(CODE8), quoter_kind: options.v4 ? 'v4_state_quoter' : 'onchain_quoter', cpmm: true, status: 'reviewed', ...(options.v4 ? { state_view: VIEW8, state_view_code_hash: keccak256(CODE8), initialization_block: '1' } : {}) });
  const registry = new DiscoveryRegistry({ networks: { [network]: { venues: options.v4 ? [venue('dex1', F8)] : [venue('dex1', F8), venue('dex2', F82)], anchors: [assetId(network, Q8)], hooks: options.hook ? [{ address: HOOK8, code_hash: keccak256(CODE8), status: 'research', reviewed_at: '2026-11-01T00:00:00.000Z' }] : [] } } });
  const pair = (id: string, dex: string) => ({ chainId: network, dexId: dex, pairAddress: id, baseToken: { address: options.reverse ? Q8 : A8, symbol: 'FIX', name: 'Fixture' }, quoteToken: { address: options.reverse ? A8 : Q8 }, priceUsd: fault === 'no-price' ? null : '1', liquidity: { usd: 20000 }, volume: { m5: 100, h24: 20000 }, priceChange: { m5: 0.1, h1: 0.5, h24: 1 }, txns: { m5: { buys: 3, sells: 1 } }, pairCreatedAt: Date.now() - 86400000 });
  const pairs = options.v4 ? [pair(poolId, 'dex1')] : [pair(P8, 'dex1'), pair(P82, 'dex2')];
  let headers = 0;
  const rpc = (request: { id: number; method: string; params: unknown[] }) => {
    calls.push(request);
    const { method, params } = request; let result: unknown;
    if (method === 'eth_chainId') result = '0x' + (fault === 'wrong-chain' ? 1 : chain).toString(16);
    else if (method === 'eth_getBlockByNumber') { headers++; if (fault === 'final-unavailable' && headers > 1) return { jsonrpc: '2.0', id: request.id, error: { code: -32000 } }; result = { number: '0x10', hash: fault === 'reorg' && headers > 1 ? '0x' + 'b'.repeat(64) : BLOCK8, timestamp: '0x1', parentHash: '0x' + 'c'.repeat(64), gasLimit: '0x100000', miner: A8 }; }
    else if (method === 'eth_getCode') result = fault === 'code' ? '0x6001' : CODE8;
    else if (method === 'eth_getLogs') {
      const abi = parseAbi(['event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)']);
      const log = { address: F8, topics: encodeEventTopics({ abi, eventName: 'Initialize', args: { id: fault === 'bad-init' ? '0x' + '0'.repeat(64) as Hex : poolId, currency0: A8 as Hex, currency1: Q8 as Hex } }), data: encodeAbiParameters(parseAbiParameters('uint24,int24,address,uint160,int24'), [key.fee, 60, key.hooks as Hex, 2n ** 96n, 0]), blockNumber: '0x10', blockHash: BLOCK8, transactionHash: BLOCK8, logIndex: '0x1', removed: false };
      if (options.nativeOnly && (params[0] as { address?: string }).address === F82) {
        const abi = parseAbi(['event PairCreated(address indexed token0,address indexed token1,address pair,uint256 pairCount)']);
        result = [{ ...log, address: F82, topics: encodeEventTopics({ abi, eventName: 'PairCreated', args: { token0: A8 as Hex, token1: Q8 as Hex } }), data: encodeAbiParameters(parseAbiParameters('address,uint256'), [P82 as Hex, 1n]) }];
      } else result = options.v4 && (params[0] as { address?: string }).address === F8 ? [log, { ...log, topics: ['0x' + 'd'.repeat(64), poolId] }] : [];
    } else if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      if (fault === 'state' && data.startsWith(toFunctionSelector('getReserves()'))) return { jsonrpc: '2.0', id: request.id, error: { code: -32000 } };
      const selector = data.slice(0, 10);
      const values: Record<string, string> = {
        [toFunctionSelector('token0()')]: words8(fault === 'wrong-currency' ? HOOK8 : A8), [toFunctionSelector('token1()')]: words8(Q8),
        [toFunctionSelector('factory()')]: words8(to === P82 ? F82 : F8), [toFunctionSelector('getPair(address,address)')]: words8(to === F82 ? P82 : P8),
        [toFunctionSelector('getReserves()')]: words8(fault === 'zero' ? 0 : 10000000000, 10000000000, 0), [toFunctionSelector('decimals()')]: words8(6),
        [toFunctionSelector('getSlot0(bytes32)')]: words8(2n ** 96n, 0, 0, 3000), [toFunctionSelector('getLiquidity(bytes32)')]: words8(fault === 'zero' ? 0 : 10000000000),
        [toFunctionSelector('slot0()')]: words8(2n ** 96n, 0), [toFunctionSelector('globalState()')]: words8(2n ** 96n, 0, 3000), [toFunctionSelector('liquidity()')]: words8(10000000000), [toFunctionSelector('fee()')]: words8(3000), [toFunctionSelector('tickSpacing()')]: words8(60),
        [toFunctionSelector('getPool(address,address,uint24)')]: words8(to === F82 ? P82 : P8), [toFunctionSelector('getPool(address,address,int24)')]: words8(to === F82 ? P82 : P8), [toFunctionSelector('poolByPair(address,address)')]: words8(to === F82 ? P82 : P8),
      };
      result = values[selector]; if (result === undefined) throw new Error('Unexpected fixture call ' + selector);
    } else throw new Error('Forbidden or unexpected RPC method ' + method);
    return { jsonrpc: '2.0', id: request.id, result };
  };
  const fetcher: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'rpc.test') { const body = JSON.parse(String(init?.body)); if (Array.isArray(body)) { const result = body.map(rpc).reverse(); return Response.json(fault === 'bad-batch' ? [result[0], result[0], ...result.slice(2)] : result); } return Response.json(rpc(body)); }
    if (parsed.hostname === 'api.geckoterminal.com') return fault === 'gecko' ? new Response('', { status: 429 }) : Response.json({ data: [{ relationships: { base_token: { data: { id: network + '_' + A8 } } } }] });
    if (parsed.pathname.includes('/token-pairs/')) return Response.json(options.nativeOnly ? pairs.slice(0, 1) : pairs);
    if (parsed.pathname.includes('/tokens/v1/')) return Response.json(pairs);
    if (parsed.pathname.includes('/search')) return Response.json({ pairs });
    if (parsed.pathname.includes('/token-profiles/')) return Response.json([{ chainId: network, tokenAddress: A8 }]);
    return Response.json([]);
  };
  return { registry, fetcher, pairs, calls, poolId, key, network };
}
