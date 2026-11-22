import { decodeFunctionResult, encodeFunctionData, encodeAbiParameters, parseAbiParameters, parseAbi, keccak256, toFunctionSelector, type Hex, type Address } from 'viem';
import { z } from 'zod';
import { evmNetwork, bytes32 } from './networks';
import { address, CHAINS, ResearchError, hash, type EvmNetwork, type Input, type PoolRef } from './contracts';
import { poolSchema, bitmapPosition, initializedTicks, type Pool } from './math';
import { JsonClient } from './transport';

export const deploymentSchema = z.object({ network: evmNetwork, address, adapter: z.enum(['UNISWAP_V2', 'UNISWAP_V3', 'UNISWAP_V4', 'WRAPPED_NATIVE', 'ALGEBRA', 'AERODROME_VOLATILE', 'AERODROME_STABLE', 'AERODROME_CLMM', 'AAVE_V3', 'BALANCER_V2', 'UNISWAP_V3_FLASH']), factory: address.optional(), factory_code_hash: z.string().regex(/^0x[0-9a-f]{64}$/).optional(), state_view: address.optional(), state_view_code_hash: z.string().regex(/^0x[0-9a-f]{64}$/).optional(), code_hash: z.string().regex(/^0x[0-9a-f]{64}$/), version: z.string().min(1), fee_pips: z.number().int().min(0).max(999999).optional(), initialization_block: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).optional() }).strict();
export type Deployment = z.infer<typeof deploymentSchema>;
export type Header = { number: string; hash: string; timestamp: string; parentHash: string; baseFeePerGas?: string; gasLimit: string; miner: string; mixHash?: string };
export const evmSnapshotSchema = z.object({ network: evmNetwork, chain_id: z.number().int(), block: z.object({ number: z.string(), hash: z.string(), timestamp: z.string(), parentHash: z.string(), baseFeePerGas: z.string().optional(), gasLimit: z.string(), miner: z.string(), mixHash: z.string().optional() }), pools: z.array(poolSchema), lender: z.object({ provider: z.string(), address, asset: address, capacity: z.string(), fee_numerator: z.string(), fee_denominator: z.string(), code_hash: z.string() }), coverage: z.array(z.object({ pool: z.union([address, bytes32]), complete: z.boolean(), word_min: z.number().int().optional(), word_max: z.number().int().optional() })), warnings: z.array(z.string()) });
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
  async header(signal?: AbortSignal, atBlock?: string): Promise<Header> {
    const chain = await this.rpc.rpc<string>('eth_chainId', [], signal);
    if (BigInt(chain) !== BigInt(CHAINS[this.network])) throw new ResearchError('CHAIN_MISMATCH', 'Configured endpoint serves a different chain.');
    const raw = await this.rpc.rpc<Header>('eth_getBlockByNumber', [atBlock === undefined ? 'latest' : '0x' + BigInt(atBlock).toString(16), false], signal);
    if (!raw?.hash || !raw.number) throw new ResearchError('INVALID_SNAPSHOT', 'RPC did not return a block identity.');
    return { number: raw.number, hash: raw.hash, timestamp: raw.timestamp, parentHash: raw.parentHash, baseFeePerGas: raw.baseFeePerGas, gasLimit: raw.gasLimit, miner: raw.miner, mixHash: raw.mixHash };
  }
  async verifyV3Factory(pool: string, token0: string, token1: string, fee: number, deployment: Deployment, block: Header, signal?: AbortSignal) {
    if (!deployment.factory || !deployment.factory_code_hash) {
      if (this.network === 'robinhood') throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'Robinhood v3 pools and lenders require a reviewed factory.');
      return;
    }
    const actual = wordAddress((await this.call(pool, 'factory()', [], block, signal))[0]);
    if (actual !== deployment.factory) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Pool belongs to a different factory.');
    const code = await this.rpc.rpc<Hex>('eth_getCode', [actual, { blockHash: block.hash, requireCanonical: true }], signal);
    if (keccak256(code) !== deployment.factory_code_hash) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Factory runtime changed.');
    const registered = wordAddress((await this.call(actual, 'getPool(address,address,uint24)', [token0, token1, BigInt(fee)], block, signal))[0]);
    if (registered !== pool) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Pool is not registered for its assets and fee.');
  }
  async v4Pool(ref: PoolRef, block: Header, signal?: AbortSignal, maxTicks = 10000): Promise<Pool> {
    const key = ref.pool_key;
    if (!key || !ref.manager) throw new ResearchError('POOL_KEY_REQUIRED', 'v4 needs a reviewed manager and the complete PoolKey.');
    if (key.hooks !== '0x' + '0'.repeat(40)) throw new ResearchError('UNSUPPORTED_HOOK', 'Only fixed-fee v4 pools with no hooks are reviewed.');
    if (BigInt(key.currency0) >= BigInt(key.currency1)) throw new ResearchError('INVALID_POOL', 'v4 currencies must be ordered and distinct.');
    const id = keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [key.currency0 as Address, key.currency1 as Address, key.fee, key.tickSpacing, key.hooks as Address]));
    if (id !== ref.address) throw new ResearchError('POOL_ID_MISMATCH', 'PoolKey does not hash to the supplied pool ID.');
    const deployment = await this.attest(ref.manager, 'UNISWAP_V4', block, signal);
    if (!deployment.state_view || !deployment.state_view_code_hash) throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'Reviewed StateView is required.');
    const viewCode = await this.rpc.rpc<Hex>('eth_getCode', [deployment.state_view, { blockHash: block.hash, requireCanonical: true }], signal);
    if (keccak256(viewCode) !== deployment.state_view_code_hash) throw new ResearchError('DEPLOYMENT_MISMATCH', 'StateView runtime changed.');
    const call = (signature: string, args: Array<string | bigint> = []) => this.call(deployment.state_view!, signature, [id, ...args], block, signal);
    const [slot, liquidity] = await Promise.all([call('getSlot0(bytes32)'), call('getLiquidity(bytes32)')]);
    if (!slot[0] || Number(slot[3]) !== key.fee) throw new ResearchError('INVALID_POOL', 'Uninitialized pool or inconsistent fee.');
    const tick = Number(BigInt.asIntN(24, slot[1])), spacing = key.tickSpacing;
    const word = bitmapPosition(tick, spacing).word, min = Math.max(-32768, word - ref.word_range), max = Math.min(32767, word + ref.word_range);
    const ticks: Array<{ tick: number; liquidity_net: string }> = [];
    for (let at = min; at <= max; at++) {
      const bitmap = (await call('getTickBitmap(bytes32,int16)', [BigInt(at)]))[0];
      for (const initialized of initializedTicks(at, bitmap, spacing)) {
        if (ticks.length >= maxTicks) throw new ResearchError('TICK_BUDGET', 'v4 tick budget exceeded.');
        const values = await call('getTickLiquidity(bytes32,int24)', [BigInt(initialized)]);
        ticks.push({ tick: initialized, liquidity_net: BigInt.asIntN(128, values[1]).toString() });
      }
    }
    const decimals = async (token: string) => token === '0x' + '0'.repeat(40) ? 18 : Number((await this.call(token, 'decimals()', [], block, signal))[0]);
    return poolSchema.parse({ address: id, token0: key.currency0, token1: key.currency1, decimals0: await decimals(key.currency0), decimals1: await decimals(key.currency1), kind: 'clmm', fee_pips: Number(slot[3]), code_hash: deployment.code_hash, adapter_version: deployment.version, sqrt_price_x96: slot[0].toString(), tick, liquidity: liquidity[0].toString(), tick_spacing: spacing, word_min: min, word_max: max, ticks, v4: { manager: ref.manager, key, protocol_fee: Number(slot[2]) } });
  }
  async pool(ref: PoolRef, block: Header, signal?: AbortSignal, maxTicks = 10000): Promise<Pool> {
    if (ref.adapter === 'UNISWAP_V4') return this.v4Pool(ref, block, signal, maxTicks);
    address.parse(ref.address);
    if (ref.manager || ref.pool_key) throw new ResearchError('INVALID_POOL', 'PoolKey metadata is only valid for v4.');
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
    if (ref.adapter === 'UNISWAP_V3') await this.verifyV3Factory(ref.address, token0, token1, fee, deployment, block, signal);
    const { word } = bitmapPosition(tick, spacing); const min = Math.max(-32768, word - ref.word_range), max = Math.min(32767, word + ref.word_range);
    const tickList: Array<{ tick: number; liquidity_net: string }> = [];
    const indices = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    const bitmaps = await this.batch(indices.map((at) => ({ to: ref.address, signature: algebra ? 'tickTable(int16)' : 'tickBitmap(int16)', args: [BigInt(at)] })), block, signal);
    const initialized = indices.flatMap((at, index) => initializedTicks(at, bitmaps[index][0], spacing));
    if (initialized.length > maxTicks) throw new ResearchError('SNAPSHOT_BUDGET', 'Initialized tick budget exceeded.');
    const states = await this.batch(initialized.map((tick) => ({ to: ref.address, signature: 'ticks(int24)', args: [BigInt(tick)] })), block, signal);
    initialized.forEach((tick, index) => tickList.push({ tick, liquidity_net: BigInt.asIntN(128, states[index][1]).toString() }));
    return poolSchema.parse({ ...base, kind: 'clmm', fee_pips: fee, sqrt_price_x96: slot[0].toString(), tick, liquidity: liquidity[0].toString(), tick_spacing: spacing, word_min: min, word_max: max, ticks: tickList });
  }
  async snapshot(input: Input<'flashloan_ingest_l2_tickmap_and_reserves'>, signal?: AbortSignal, maxTicks?: number, atBlock?: string): Promise<EvmSnapshot> {
    const block = await this.header(signal, atBlock); const pools: Pool[] = [];
    if (new Set(input.pools.map((p) => p.address)).size !== input.pools.length) throw new ResearchError('DUPLICATE_POOL', 'Pool references must be unique.');
    let tickCount = 0;
    for (const ref of input.pools) {
      const pool = await this.pool(ref, block, signal, maxTicks === undefined ? 10000 : maxTicks - tickCount);
      if (pool.kind === 'clmm') tickCount += pool.ticks.length;
      pools.push(pool);
    }
    if (this.network === 'robinhood' && pools.some((p) => p.token0 === '0x' + '0'.repeat(40) || p.token1 === '0x' + '0'.repeat(40))) {
      const wrapped = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
      const attestation = await this.attest(wrapped, 'WRAPPED_NATIVE', block, signal);
      for (const direction of ['wrap', 'unwrap'] as const) pools.push(poolSchema.parse({ kind: 'wrap', address: keccak256(new TextEncoder().encode('robinhood:' + direction)), token0: wrapped, token1: '0x' + '0'.repeat(40), decimals0: 18, decimals1: 18, fee_pips: 0, code_hash: attestation.code_hash, adapter_version: attestation.version, wrapped_native: wrapped, direction }));
    }
    const l = input.lender; const attestation = await this.attest(l.address, l.provider, block, signal);
    let custody = l.address, numerator: bigint, denominator: bigint;
    if (l.provider === 'AAVE_V3') {
      const data = await this.call(l.address, 'getReserveData(address)', [l.asset], block, signal);
      if (data.length < 9 || !(data[0] & 1n << 56n) || !(data[0] & 1n << 63n) || data[0] & 1n << 60n) throw new ResearchError('LENDER_UNAVAILABLE', 'Aave flashloan reserve is inactive, disabled or paused.');
      custody = wordAddress(data[8]); numerator = (await this.call(l.address, 'FLASHLOAN_PREMIUM_TOTAL()', [], block, signal))[0]; denominator = 10000n;
    } else if (l.provider === 'BALANCER_V2') {
      const collector = wordAddress((await this.call(l.address, 'getProtocolFeesCollector()', [], block, signal))[0]);
      numerator = (await this.call(collector, 'getFlashLoanFeePercentage()', [], block, signal))[0]; denominator = 10n ** 18n;
    } else { numerator = (await this.call(l.address, 'fee()', [], block, signal))[0]; denominator = 1000000n;
      const [t0, t1] = await Promise.all([this.call(l.address, 'token0()', [], block, signal), this.call(l.address, 'token1()', [], block, signal)]);
      if (![wordAddress(t0[0]), wordAddress(t1[0])].includes(l.asset)) throw new ResearchError('INVALID_ASSET', 'Flash lender does not contain the funding asset.');
      await this.verifyV3Factory(l.address, wordAddress(t0[0]), wordAddress(t1[0]), Number(numerator), attestation, block, signal);
    }
    const capacity = (await this.call(l.asset, 'balanceOf(address)', [custody], block, signal))[0];
    const canonicalBlock = await this.rpc.rpc<Header>('eth_getBlockByNumber', [block.number, false], signal);
    if (canonicalBlock.hash !== block.hash) throw new ResearchError('REORG', 'Snapshot block was reorganized; refresh state.', true);
    return evmSnapshotSchema.parse({ network: this.network, chain_id: CHAINS[this.network], block, pools, lender: { ...l, capacity: capacity.toString(), fee_numerator: numerator.toString(), fee_denominator: denominator.toString(), code_hash: attestation.code_hash }, coverage: pools.map((p) => ({ pool: p.address, complete: p.kind !== 'clmm', ...(p.kind === 'clmm' ? { word_min: p.word_min, word_max: p.word_max } : {}) })), warnings: ['Token transfer taxes and restrictions are unknown until execution simulation.', 'Concentrated-liquidity coverage is bounded; quotes outside it fail explicitly.', 'Stable curves and dynamic-fee protocol quotes are estimates until exact native execution parity is established.'] });
  }
}
export function snapshotHash(snapshot: EvmSnapshot): string { return hash(snapshot); }
