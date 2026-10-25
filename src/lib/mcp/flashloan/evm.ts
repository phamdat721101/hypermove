import { decodeFunctionResult, encodeFunctionData, parseAbi, keccak256, toFunctionSelector, type Hex, type Address } from 'viem';
import { z } from 'zod';
import { address, CHAINS, ResearchError, hash, type EvmNetwork, type Input, type PoolRef } from './contracts';
import { poolSchema, bitmapPosition, initializedTicks, type Pool } from './math';
import { JsonClient } from './transport';

export const deploymentSchema = z.object({ network: z.enum(['ethereum', 'arbitrum', 'base']), address, adapter: z.enum(['UNISWAP_V2', 'UNISWAP_V3', 'ALGEBRA', 'AERODROME_VOLATILE', 'AERODROME_STABLE', 'AERODROME_CLMM', 'AAVE_V3', 'BALANCER_V2', 'UNISWAP_V3_FLASH']), code_hash: z.string().regex(/^0x[0-9a-f]{64}$/), version: z.string().min(1), fee_pips: z.number().int().min(0).max(999999).optional() }).strict();
export type Deployment = z.infer<typeof deploymentSchema>;
export type Header = { number: string; hash: string; timestamp: string; parentHash: string; baseFeePerGas?: string; gasLimit: string; miner: string; mixHash?: string };
export const evmSnapshotSchema = z.object({ network: z.enum(['ethereum', 'arbitrum', 'base']), chain_id: z.number().int(), block: z.object({ number: z.string(), hash: z.string(), timestamp: z.string(), parentHash: z.string(), baseFeePerGas: z.string().optional(), gasLimit: z.string(), miner: z.string(), mixHash: z.string().optional() }), pools: z.array(poolSchema), lender: z.object({ provider: z.string(), address, asset: address, capacity: z.string(), fee_numerator: z.string(), fee_denominator: z.string(), code_hash: z.string() }), coverage: z.array(z.object({ pool: address, complete: z.boolean(), word_min: z.number().int().optional(), word_max: z.number().int().optional() })), warnings: z.array(z.string()) });
export type EvmSnapshot = z.infer<typeof evmSnapshotSchema>;
export function encodeCall(signature: string, args: Array<bigint | string> = []): Hex {
  return (toFunctionSelector(signature) + args.map((v) => typeof v === 'bigint' ? BigInt.asUintN(256, v).toString(16).padStart(64, '0') : v.replace(/^0x/, '').padStart(64, '0')).join('')) as Hex;
}
export function words(data: string): bigint[] {
  if (!/^0x(?:[a-fA-F0-9]{64})+$/.test(data)) throw new ResearchError('INVALID_RPC_DATA', 'Invalid ABI word response.');
  return data.slice(2).match(/.{64}/g)!.map((word) => BigInt('0x' + word));
}
function wordAddress(word: bigint): string { return '0x' + word.toString(16).padStart(40, '0').slice(-40); }
export class EvmReader {
  constructor(readonly rpc: JsonClient, readonly network: EvmNetwork, private readonly deployments: Deployment[]) {}
  async call(to: string, signature: string, args: Array<string | bigint>, block: Header, signal?: AbortSignal) {
    return words(await this.rpc.rpc<string>('eth_call', [{ to, data: encodeCall(signature, args) }, { blockHash: block.hash, requireCanonical: true }], signal));
  }
  async batch(calls: Array<{ to: string; signature: string; args?: Array<string | bigint> }>, block: Header, signal?: AbortSignal): Promise<bigint[][]> {
    if (!calls.length) return [];
    const multicall = '0xca11bde05977b3631167028862be2a173976ca11';
    const abi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
    const results: bigint[][] = [];
    for (let at = 0; at < calls.length; at += 128) {
      const chunk = calls.slice(at, at + 128);
      const data = encodeFunctionData({ abi, functionName: 'aggregate3', args: [chunk.map((call) => ({ target: call.to as Address, allowFailure: true, callData: encodeCall(call.signature, call.args ?? []) }))] });
      const raw = await this.rpc.rpc<Hex>('eth_call', [{ to: multicall, data }, { blockHash: block.hash, requireCanonical: true }], signal);
      const decoded = decodeFunctionResult({ abi, functionName: 'aggregate3', data: raw });
      if (decoded.length !== chunk.length || decoded.some((entry) => !entry.success)) throw new ResearchError('INCOMPLETE_MULTICALL', 'A required snapshot subcall failed.');
      results.push(...decoded.map((entry) => words(entry.returnData)));
    }
    return results;
  }
  async attest(to: string, adapter: Deployment['adapter'], block: Header, signal?: AbortSignal): Promise<Deployment> {
    const found = this.deployments.find((d) => d.network === this.network && d.address === to && d.adapter === adapter);
    if (!found) throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'Deployment is not in the reviewed registry.');
    const code = await this.rpc.rpc<Hex>('eth_getCode', [to, { blockHash: block.hash, requireCanonical: true }], signal);
    if (code === '0x' || keccak256(code) !== found.code_hash) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Runtime code differs from the reviewed deployment.');
    return found;
  }
  async header(signal?: AbortSignal): Promise<Header> {
    const chain = await this.rpc.rpc<string>('eth_chainId', [], signal);
    if (BigInt(chain) !== BigInt(CHAINS[this.network])) throw new ResearchError('CHAIN_MISMATCH', 'Configured endpoint serves a different chain.');
    const raw = await this.rpc.rpc<Header>('eth_getBlockByNumber', ['latest', false], signal);
    if (!raw?.hash || !raw.number) throw new ResearchError('INVALID_SNAPSHOT', 'RPC did not return a block identity.');
    return { number: raw.number, hash: raw.hash, timestamp: raw.timestamp, parentHash: raw.parentHash, baseFeePerGas: raw.baseFeePerGas, gasLimit: raw.gasLimit, miner: raw.miner, mixHash: raw.mixHash };
  }
  async pool(ref: PoolRef, block: Header, signal?: AbortSignal): Promise<Pool> {
    const deployment = await this.attest(ref.address, ref.adapter, block, signal);
    const call = (sig: string, args: Array<string | bigint> = []) => this.call(ref.address, sig, args, block, signal);
    const [token0raw, token1raw] = await this.batch([{ to: ref.address, signature: 'token0()' }, { to: ref.address, signature: 'token1()' }], block, signal);
    const token0 = wordAddress(token0raw[0]), token1 = wordAddress(token1raw[0]);
    if (token0 === token1 || token0 === '0x' + '0'.repeat(40)) throw new ResearchError('INVALID_POOL', 'Invalid token identity.');
    const [d0, d1] = await this.batch([{ to: token0, signature: 'decimals()' }, { to: token1, signature: 'decimals()' }], block, signal);
    const base = { address: ref.address, token0, token1, decimals0: Number(d0[0]), decimals1: Number(d1[0]), fee_pips: 0, code_hash: deployment.code_hash, adapter_version: deployment.version };
    if (['UNISWAP_V2', 'AERODROME_VOLATILE', 'AERODROME_STABLE'].includes(ref.adapter)) {
      const reserves = await call('getReserves()'); let fee = deployment.fee_pips;
      if (ref.adapter.startsWith('AERODROME')) {
        const [factoryRaw, stableRaw] = await Promise.all([call('factory()'), call('stable()')]);
        const stable = stableRaw[0] === 1n;
        if (stable !== (ref.adapter === 'AERODROME_STABLE')) throw new ResearchError('INVALID_POOL', 'Stable/volatile adapter mismatch.');
        fee = Number((await this.call(wordAddress(factoryRaw[0]), 'getFee(address,bool)', [ref.address, stable ? 1n : 0n], block, signal))[0]) * 100;
      }
      if (fee === undefined) throw new ResearchError('UNKNOWN_POOL_FEE', 'Reviewed V2 fee is missing.');
      return poolSchema.parse({ ...base, kind: 'v2', fee_pips: fee, reserve0: reserves[0].toString(), reserve1: reserves[1].toString(), stable: ref.adapter === 'AERODROME_STABLE' });
    }
    const algebra = ref.adapter === 'ALGEBRA';
    if (algebra && deployment.version !== 'algebra-v1') throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'Only the reviewed Algebra v1 ABI is supported.');
    const [slot, liquidity, spacingRaw] = await this.batch([algebra ? 'globalState()' : 'slot0()', 'liquidity()', 'tickSpacing()'].map((signature) => ({ to: ref.address, signature })), block, signal);
    const tick = Number(BigInt.asIntN(24, slot[1])), spacing = Number(BigInt.asIntN(24, spacingRaw[0]));
    const fee = algebra ? Number(slot[2]) : Number((await call('fee()'))[0]);
    const { word } = bitmapPosition(tick, spacing); const min = Math.max(-32768, word - ref.word_range), max = Math.min(32767, word + ref.word_range);
    const tickList: Array<{ tick: number; liquidity_net: string }> = [];
    const indices = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    const bitmaps = await this.batch(indices.map((at) => ({ to: ref.address, signature: algebra ? 'tickTable(int16)' : 'tickBitmap(int16)', args: [BigInt(at)] })), block, signal);
    const initialized = indices.flatMap((at, index) => initializedTicks(at, bitmaps[index][0], spacing));
    if (initialized.length > 10000) throw new ResearchError('SNAPSHOT_BUDGET', 'Initialized tick budget exceeded.');
    const states = await this.batch(initialized.map((tick) => ({ to: ref.address, signature: 'ticks(int24)', args: [BigInt(tick)] })), block, signal);
    initialized.forEach((tick, index) => tickList.push({ tick, liquidity_net: BigInt.asIntN(128, states[index][1]).toString() }));
    return poolSchema.parse({ ...base, kind: 'clmm', fee_pips: fee, sqrt_price_x96: slot[0].toString(), tick, liquidity: liquidity[0].toString(), tick_spacing: spacing, word_min: min, word_max: max, ticks: tickList });
  }
  async snapshot(input: Input<'flashloan_ingest_l2_tickmap_and_reserves'>, signal?: AbortSignal): Promise<EvmSnapshot> {
    const block = await this.header(signal); const pools: Pool[] = [];
    if (new Set(input.pools.map((p) => p.address)).size !== input.pools.length) throw new ResearchError('DUPLICATE_POOL', 'Pool references must be unique.');
    for (const ref of input.pools) pools.push(await this.pool(ref, block, signal));
    const l = input.lender; const attestation = await this.attest(l.address, l.provider, block, signal);
    let custody = l.address, numerator: bigint, denominator: bigint;
    if (l.provider === 'AAVE_V3') {
      const data = await this.call(l.address, 'getReserveData(address)', [l.asset], block, signal);
      if (data.length < 9 || !(data[0] & 1n << 56n) || !(data[0] & 1n << 63n) || data[0] & 1n << 60n) throw new ResearchError('LENDER_UNAVAILABLE', 'Aave flashloan reserve is inactive, disabled or paused.');
      custody = wordAddress(data[8]); numerator = (await this.call(l.address, 'FLASHLOAN_PREMIUM_TOTAL()', [], block, signal))[0]; denominator = 10000n;
    } else if (l.provider === 'BALANCER_V2') {
      const collector = wordAddress((await this.call(l.address, 'getProtocolFeesCollector()', [], block, signal))[0]);
      numerator = (await this.call(collector, 'getFlashLoanFeePercentage()', [], block, signal))[0]; denominator = 10n ** 18n;
    } else { numerator = (await this.call(l.address, 'fee()', [], block, signal))[0]; denominator = 1000000n; }
    const capacity = (await this.call(l.asset, 'balanceOf(address)', [custody], block, signal))[0];
    const canonicalBlock = await this.rpc.rpc<Header>('eth_getBlockByNumber', [block.number, false], signal);
    if (canonicalBlock.hash !== block.hash) throw new ResearchError('REORG', 'Snapshot block was reorganized; refresh state.', true);
    return evmSnapshotSchema.parse({ network: this.network, chain_id: CHAINS[this.network], block, pools, lender: { ...l, capacity: capacity.toString(), fee_numerator: numerator.toString(), fee_denominator: denominator.toString(), code_hash: attestation.code_hash }, coverage: pools.map((p) => ({ pool: p.address, complete: p.kind === 'v2', ...(p.kind === 'clmm' ? { word_min: p.word_min, word_max: p.word_max } : {}) })), warnings: ['Token transfer taxes and restrictions are unknown until execution simulation.', 'Concentrated-liquidity coverage is bounded; quotes outside it fail explicitly.', 'Stable curves and dynamic-fee protocol quotes are estimates until exact native execution parity is established.'] });
  }
}
export function snapshotHash(snapshot: EvmSnapshot): string { return hash(snapshot); }
