import { decodeFunctionResult, encodeFunctionData, encodeAbiParameters, encodePacked, getCreate2Address, parseAbiParameters, parseAbi, keccak256, toFunctionSelector, type Hex, type Address } from 'viem';
import { z } from 'zod';
import { evmNetwork, bytes32 } from './networks';
import { address, CHAINS, ResearchError, hash, type EvmNetwork, type Input, type PoolRef } from './contracts';
import { poolSchema, bitmapPosition, initializedTicks, quoteCapability, saltKind, canonicalityProofSchema, type Pool, type CanonicalityProof } from './math';
import { JsonClient } from './transport';

export const deploymentSchema = z.object({ network: evmNetwork, address, adapter: z.enum(['UNISWAP_V2', 'UNISWAP_V3', 'UNISWAP_V4', 'WRAPPED_NATIVE', 'ALGEBRA', 'AERODROME_VOLATILE', 'AERODROME_STABLE', 'AERODROME_CLMM', 'AAVE_V3', 'BALANCER_V2', 'UNISWAP_V3_FLASH', 'MORPHO_BLUE']), factory: address.optional(), factory_code_hash: z.string().regex(/^0x[0-9a-f]{64}$/).optional(), state_view: address.optional(), state_view_code_hash: z.string().regex(/^0x[0-9a-f]{64}$/).optional(), code_hash: z.string().regex(/^0x[0-9a-f]{64}$/), version: z.string().min(1), fee_pips: z.number().int().min(0).max(999999).optional(), initialization_block: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).optional(),
  // Factory template (A5'): a pool not pinned by address is sized only when the factory registers it AND it is the CREATE2 image of these values.
  deployer: address.optional(), init_code_hash: z.string().regex(/^0x[0-9a-f]{64}$/).optional(), salt_kind: saltKind.optional(), adapter_version: z.string().min(1).optional(), canonicality: canonicalityProofSchema.optional() }).strict()
  .refine((d) => [d.deployer, d.init_code_hash, d.salt_kind].every((v) => v === undefined) || Boolean(d.deployer && d.init_code_hash && d.salt_kind && d.factory && d.factory_code_hash), 'A factory template needs deployer, init_code_hash, salt_kind, factory and factory_code_hash together.');

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
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const aggregate3 = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
export type BatchCall = { to: string; signature: string; args?: Array<string | bigint> };
/** One Multicall3 member's outcome; a failed member carries an explicit reason and never fails its siblings. */
export type Settled = { ok: true; words: bigint[] } | { ok: false; reason: 'SUBCALL_REVERTED' | 'INVALID_RPC_DATA' };
export type SaltKind = CanonicalityProof['salt_kind'];
/** Factory registry lookup per family; the single table shared by sizing (`EvmReader`) and discovery (`inventory-v3`). */
export type FactoryLookup = 'getPair' | 'getPoolStable' | 'getPoolVolatile' | 'getPoolFee' | 'getPoolSpacing' | 'poolByPair';
export type MembershipClaim = { pool: string; factory: string; lookup: FactoryLookup; token0: string; token1: string; param?: bigint };
export function factoryLookupCall(claim: MembershipClaim): BatchCall {
  const pair = [claim.token0, claim.token1];
  switch (claim.lookup) {
    case 'getPair': return { to: claim.factory, signature: 'getPair(address,address)', args: pair };
    case 'poolByPair': return { to: claim.factory, signature: 'poolByPair(address,address)', args: pair };
    case 'getPoolStable': case 'getPoolVolatile': return { to: claim.factory, signature: 'getPool(address,address,bool)', args: [...pair, claim.lookup === 'getPoolStable' ? 1n : 0n] };
    case 'getPoolFee': case 'getPoolSpacing':
      if (claim.param === undefined) throw new ResearchError('INVALID_POOL', 'Fee or tick spacing is required for this factory lookup.');
      return { to: claim.factory, signature: claim.lookup === 'getPoolFee' ? 'getPool(address,address,uint24)' : 'getPool(address,address,int24)', args: [...pair, claim.param] };
  }
}
export const saltLookup: Record<SaltKind, FactoryLookup> = { V3_FEE: 'getPoolFee', SPACING: 'getPoolSpacing', ALGEBRA: 'poolByPair', V2_PACKED: 'getPair' };
/**
 * A5' CREATE2 derivation: recompute the pool address from a reviewed template and compare.
 * V3_FEE abi.encode(t0,t1,fee) · SPACING abi.encode(t0,t1,tickSpacing) (Slipstream: EIP-1167 clone, hash of the clone init code) ·
 * ALGEBRA abi.encode(t0,t1) · V2_PACKED abi.encodePacked(t0,t1).
 */
export function verifyCreate2Derivation(template: { deployer: string; init_code_hash: string; salt_kind: SaltKind }, pool: string, token0: string, token1: string, param?: bigint) {
  const t0 = token0 as Address, t1 = token1 as Address;
  if ((template.salt_kind === 'V3_FEE' || template.salt_kind === 'SPACING') && param === undefined) throw new ResearchError('INVALID_POOL', 'Fee or tick spacing is required for this salt.');
  const salt = keccak256(template.salt_kind === 'V2_PACKED' ? encodePacked(['address', 'address'], [t0, t1])
    : template.salt_kind === 'ALGEBRA' ? encodeAbiParameters(parseAbiParameters('address,address'), [t0, t1])
    : template.salt_kind === 'V3_FEE' ? encodeAbiParameters(parseAbiParameters('address,address,uint24'), [t0, t1, Number(param)])
    : encodeAbiParameters(parseAbiParameters('address,address,int24'), [t0, t1, Number(BigInt.asIntN(24, param!))]));
  const derived = getCreate2Address({ from: template.deployer as Address, salt, bytecodeHash: template.init_code_hash as Hex }).toLowerCase();
  const salt_args = [token0.toLowerCase(), token1.toLowerCase(), ...(param === undefined || template.salt_kind === 'ALGEBRA' || template.salt_kind === 'V2_PACKED' ? [] : [BigInt.asIntN(24, param).toString()])];
  return { matches: derived === pool.toLowerCase(), derived, salt, salt_args };
}
export class EvmReader {
  constructor(readonly rpc: JsonClient, readonly network: EvmNetwork, private readonly deployments: Deployment[]) {}
  async call(to: string, signature: string, args: Array<string | bigint>, block: Header, signal?: AbortSignal) {
    return words(await this.rpc.rpc<string>('eth_call', [{ to, data: encodeCall(signature, args) }, { blockHash: block.hash, requireCanonical: true }], signal));
  }
  private async aggregate(chunk: BatchCall[], block: Header, signal?: AbortSignal): Promise<Settled[]> {
    const data = encodeFunctionData({ abi: aggregate3, functionName: 'aggregate3', args: [chunk.map((call) => ({ target: call.to as Address, allowFailure: true, callData: encodeCall(call.signature, call.args ?? []) }))] });
    const raw = await this.rpc.rpc<Hex>('eth_call', [{ to: MULTICALL3, data }, { blockHash: block.hash, requireCanonical: true }], signal);
    const decoded = decodeFunctionResult({ abi: aggregate3, functionName: 'aggregate3', data: raw });
    if (decoded.length !== chunk.length) throw new ResearchError('INCOMPLETE_MULTICALL', 'Multicall returned a different number of results.');
    return decoded.map((entry): Settled => {
      if (!entry.success) return { ok: false, reason: 'SUBCALL_REVERTED' };
      if (!/^0x(?:[a-fA-F0-9]{64})+$/.test(entry.returnData)) return { ok: false, reason: 'INVALID_RPC_DATA' };
      return { ok: true, words: words(entry.returnData) };
    });
  }
  /** Strict: any failed member fails the whole read (unchanged behaviour). */
  async batch(calls: BatchCall[], block: Header, signal?: AbortSignal): Promise<bigint[][]> {
    const results: bigint[][] = [];
    for (let at = 0; at < calls.length; at += 128) {
      const settled = await this.aggregate(calls.slice(at, at + 128), block, signal);
      if (settled.some((entry) => !entry.ok)) throw settled.some((entry) => !entry.ok && entry.reason === 'SUBCALL_REVERTED') ? new ResearchError('INCOMPLETE_MULTICALL', 'A required snapshot subcall failed.') : new ResearchError('INVALID_RPC_DATA', 'Invalid ABI word response.');
      results.push(...settled.map((entry) => (entry as { words: bigint[] }).words));
    }
    return results;
  }
  /** A2'': per-member outcome; one member's failure never throws. Transport or shape failure of the whole call still throws. */
  async batchSettled(calls: BatchCall[], block: Header, signal?: AbortSignal): Promise<Settled[]> {
    const results: Settled[] = [];
    for (let at = 0; at < calls.length; at += 128) results.push(...await this.aggregate(calls.slice(at, at + 128), block, signal));
    return results;
  }
  /** Factory registers each claimed pool (one batched read); per-claim result, never throws on a single claim. */
  async verifyFactoryMembership(claims: MembershipClaim[], block: Header, signal?: AbortSignal): Promise<Array<{ ok: true } | { ok: false; code: 'DEPLOYMENT_MISMATCH' | 'MULTICALL_MEMBER_FAILED'; reason: string }>> {
    const settled = await this.batchSettled(claims.map(factoryLookupCall), block, signal);
    return settled.map((entry, i) => !entry.ok ? { ok: false, code: 'MULTICALL_MEMBER_FAILED', reason: 'factory lookup ' + entry.reason }
      : wordAddress(entry.words[0]) !== claims[i].pool.toLowerCase() ? { ok: false, code: 'DEPLOYMENT_MISMATCH', reason: 'Factory does not register this pool.' } : { ok: true });
  }
  /** Throwing form for the sizing path: factory runtime is the reviewed one and it registers the pool. */
  private async requireFactoryMembership(claim: MembershipClaim, factoryCodeHash: string, block: Header, signal?: AbortSignal) {
    const code = await this.rpc.rpc<Hex>('eth_getCode', [claim.factory, { blockHash: block.hash, requireCanonical: true }], signal);
    if (keccak256(code) !== factoryCodeHash) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Factory runtime changed.');
    const [result] = await this.verifyFactoryMembership([claim], block, signal);
    if (!result.ok) throw new ResearchError(result.code, result.reason);
  }
  async attest(to: string, adapter: Deployment['adapter'], block: Header, signal?: AbortSignal): Promise<Deployment> {
    const found = this.deployments.find((d) => d.network === this.network && d.address === to && d.adapter === adapter && !d.init_code_hash);
    if (!found) return this.derive(to, adapter, block, signal);
    const code = await this.rpc.rpc<Hex>('eth_getCode', [to, { blockHash: block.hash, requireCanonical: true }], signal);
    if (code === '0x' || keccak256(code) !== found.code_hash) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Runtime code differs from the reviewed deployment.');
    return found;
  }
  /**
   * A5': a pool that is not pinned by address is accepted for sizing only when its reviewed factory registers it
   * AND it is the CREATE2 image of that factory template. The derived deployment carries the canonicality proof.
   */
  private async derive(to: string, adapter: Deployment['adapter'], block: Header, signal?: AbortSignal): Promise<Deployment> {
    const templates = this.deployments.filter((d) => d.network === this.network && d.adapter === adapter && d.init_code_hash);
    if (!templates.length) throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'Deployment is not in the reviewed registry.');
    const kinds = [...new Set(templates.map((t) => t.salt_kind!))];
    if (kinds.length !== 1) throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'Ambiguous factory templates for this adapter.');
    const kind = kinds[0], paramSignature = kind === 'V3_FEE' ? 'fee()' : kind === 'SPACING' ? 'tickSpacing()' : undefined;
    const reads = await this.batchSettled([{ to, signature: 'token0()' }, { to, signature: 'token1()' }, { to, signature: 'factory()' }, ...(paramSignature ? [{ to, signature: paramSignature }] : [])], block, signal);
    if (reads.some((r) => !r.ok)) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Pool does not expose the reviewed factory interface.');
    const [token0, token1, factory] = reads.slice(0, 3).map((r) => wordAddress((r as { words: bigint[] }).words[0]));
    const param = paramSignature ? (reads[3] as { words: bigint[] }).words[0] : undefined;
    const template = templates.find((t) => t.factory === factory);
    if (!template) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Pool belongs to an unreviewed factory.');
    await this.requireFactoryMembership({ pool: to, factory, lookup: saltLookup[kind], token0, token1, param }, template.factory_code_hash!, block, signal);
    const derivation = verifyCreate2Derivation({ deployer: template.deployer!, init_code_hash: template.init_code_hash!, salt_kind: kind }, to, token0, token1, param);
    if (!derivation.matches) throw new ResearchError('CREATE2_MISMATCH', 'Pool address is not the CREATE2 image of the reviewed factory template; discovery-only.');
    const code = await this.rpc.rpc<Hex>('eth_getCode', [to, { blockHash: block.hash, requireCanonical: true }], signal);
    if (code === '0x') throw new ResearchError('DEPLOYMENT_MISMATCH', 'Pool has no runtime code.');
    const version = template.adapter_version ?? template.version;
    const canonicality = canonicalityProofSchema.parse({ kind: 'create2', chain_id: CHAINS[this.network], adapter_version: version, factory, deployer: template.deployer, init_code_hash: template.init_code_hash, salt_kind: kind, salt_args: derivation.salt_args, salt: derivation.salt });
    return deploymentSchema.parse({ ...template, address: to, code_hash: keccak256(code), version, canonicality });
  }
  async header(signal?: AbortSignal, atBlock?: string): Promise<Header> {
    const chain = await this.rpc.rpc<string>('eth_chainId', [], signal);
    if (BigInt(chain) !== BigInt(CHAINS[this.network])) throw new ResearchError('CHAIN_MISMATCH', 'Configured endpoint serves a different chain.');
    const raw = await this.rpc.rpc<Header>('eth_getBlockByNumber', [atBlock === undefined ? 'latest' : '0x' + BigInt(atBlock).toString(16), false], signal);
    if (!raw?.hash || !raw.number) throw new ResearchError('INVALID_SNAPSHOT', 'RPC did not return a block identity.');
    return { number: raw.number, hash: raw.hash, timestamp: raw.timestamp, parentHash: raw.parentHash, baseFeePerGas: raw.baseFeePerGas, gasLimit: raw.gasLimit, miner: raw.miner, mixHash: raw.mixHash };
  }
  /** Pinned-deployment factory check (pool and V3 flash lender); derived deployments were already proven in `derive`. */
  private async verifyPinnedFactory(pool: string, token0: string, token1: string, lookup: FactoryLookup, param: bigint | undefined, deployment: Deployment, block: Header, signal?: AbortSignal) {
    if (deployment.canonicality) return;
    if (!deployment.factory || !deployment.factory_code_hash) {
      if (this.network === 'robinhood') throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'Robinhood v3 pools and lenders require a reviewed factory.');
      return;
    }
    const actual = wordAddress((await this.call(pool, 'factory()', [], block, signal))[0]);
    if (actual !== deployment.factory) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Pool belongs to a different factory.');
    await this.requireFactoryMembership({ pool, factory: actual, lookup, token0, token1, param }, deployment.factory_code_hash, block, signal);
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
    const capability = quoteCapability(ref.adapter, deployment.adapter_version ?? deployment.version, { dynamic_fee: /dynamic|deltaswap/i.test(deployment.adapter_version ?? deployment.version) });
    if (capability === 'none') throw new ResearchError('QUOTE_UNSUPPORTED', 'No exact or estimate quote model for this pool family; it is discovery-only.');
    const base = { address: ref.address, token0, token1, decimals0: Number(d0[0]), decimals1: Number(d1[0]), fee_pips: 0, code_hash: deployment.code_hash, adapter_version: deployment.version, ...(capability === 'estimate' ? { quote_capability: 'estimate' as const } : {}), ...(deployment.canonicality ? { canonicality: deployment.canonicality } : {}) };
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
    if (ref.adapter === 'UNISWAP_V3') await this.verifyPinnedFactory(ref.address, token0, token1, 'getPoolFee', BigInt(fee), deployment, block, signal);
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
    } else if (l.provider === 'MORPHO_BLUE') {
      // Morpho Blue has no flash fee parameter: flashLoan() pulls back exactly `assets`. Capacity is the token balance it custodies.
      numerator = 0n; denominator = 1n;
    } else { numerator = (await this.call(l.address, 'fee()', [], block, signal))[0]; denominator = 1000000n;
      const [t0, t1] = await Promise.all([this.call(l.address, 'token0()', [], block, signal), this.call(l.address, 'token1()', [], block, signal)]);
      if (![wordAddress(t0[0]), wordAddress(t1[0])].includes(l.asset)) throw new ResearchError('INVALID_ASSET', 'Flash lender does not contain the funding asset.');
      await this.verifyPinnedFactory(l.address, wordAddress(t0[0]), wordAddress(t1[0]), 'getPoolFee', numerator, attestation, block, signal);
    }
    const capacity = (await this.call(l.asset, 'balanceOf(address)', [custody], block, signal))[0];
    const canonicalBlock = await this.rpc.rpc<Header>('eth_getBlockByNumber', [block.number, false], signal);
    if (canonicalBlock.hash !== block.hash) throw new ResearchError('REORG', 'Snapshot block was reorganized; refresh state.', true);
    return evmSnapshotSchema.parse({ network: this.network, chain_id: CHAINS[this.network], block, pools, lender: { ...l, capacity: capacity.toString(), fee_numerator: numerator.toString(), fee_denominator: denominator.toString(), code_hash: attestation.code_hash }, coverage: pools.map((p) => ({ pool: p.address, complete: p.kind !== 'clmm', ...(p.kind === 'clmm' ? { word_min: p.word_min, word_max: p.word_max } : {}) })), warnings: ['Token transfer taxes and restrictions are unknown until execution simulation.', 'Concentrated-liquidity coverage is bounded; quotes outside it fail explicitly.', 'Stable curves and dynamic-fee protocol quotes are estimates until exact native execution parity is established.'] });
  }
}
export function snapshotHash(snapshot: EvmSnapshot): string { return hash(snapshot); }
