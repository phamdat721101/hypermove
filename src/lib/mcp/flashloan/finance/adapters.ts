import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex, type Address } from 'viem';
import { createHash } from 'node:crypto';
import { canonical } from '../contracts';
import { encodeCall, words, type Header } from '../evm';
import type { JsonClient } from '../transport';
import { CHAIN_IDS, FinanceError, RAY, expm1Ray, rayToDecimal, annualiseRatio } from './contracts';

/**
 * Finance EVM reads. Reuses the legacy ABI helpers and JsonClient (verified HTTPS,
 * bounded retries) but keeps its own reader because Finance needs (a) Flare, which
 * the legacy chain map deliberately excludes, and (b) per-call failure isolation:
 * one bad market must not blank a whole page (legacy EvmReader.batch fails all).
 */
export type EvmNet = 'arbitrum' | 'base' | 'flare';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const SECONDS_PER_YEAR = 31_536_000n;
const WAD = 10n ** 18n;
const MAX_UINT = (1n << 256n) - 1n;

export const sha256 = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');

const ABI = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
  'function getReservesList() view returns (address[])',
  'function symbol() view returns (string)',
  'function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee) market) view returns (uint256)',
]);

export type Call = { to: string; data: Hex };
export const call = (to: string, signature: string, args: Array<string | bigint> = []): Call => ({ to, data: encodeCall(signature, args) });
/** Pinned EVM observation (one canonical block hash) shared by position reports and rates. */
export function evmObservation(network: EvmNet, block: Header, now: number, ttlMs: number, source: unknown) {
  const expiresAt = new Date(now + ttlMs).toISOString();
  return {
    network, networkIdentityHash: sha256({ family: 'evm', chainId: CHAIN_IDS[network] }),
    point: { kind: 'evm-block', number: BigInt(block.number).toString(), hash: block.hash.toLowerCase(), finality: 'included' },
    observedAt: new Date(now).toISOString(), expiresAt, consistency: 'pinned', fidelity: 'chain-read',
    sources: [{ id: sha256(source), contentHash: sha256({ block: block.hash }), expiresAt }],
  };
}
const addr = (word: bigint) => '0x' + word.toString(16).padStart(40, '0').slice(-40);

export class FinanceEvmReader {
  private verified = false;
  constructor(readonly rpc: JsonClient, readonly network: EvmNet) {}
  private async verifyChain(signal?: AbortSignal) {
    if (this.verified) return;
    const chain = await this.rpc.rpc<string>('eth_chainId', [], signal);
    if (BigInt(chain) !== BigInt(CHAIN_IDS[this.network])) throw new FinanceError('WRONG_CHAIN', `Configured ${this.network} endpoint serves a different chain.`);
    this.verified = true;
  }
  async header(signal?: AbortSignal, at: 'latest' | 'finalized' | bigint = 'latest'): Promise<Header> {
    await this.verifyChain(signal);
    const tag = typeof at === 'bigint' ? '0x' + at.toString(16) : at;
    const raw = await this.rpc.rpc<Header | null>('eth_getBlockByNumber', [tag, false], signal);
    if (!raw?.hash || !raw.number) {
      if (at === 'finalized') return this.header(signal, 'latest');
      throw new FinanceError('COVERAGE_INCOMPLETE', 'RPC did not return a block identity.');
    }
    return raw;
  }
  async raw(c: Call, block: Header, signal?: AbortSignal): Promise<Hex> {
    return this.rpc.rpc<Hex>('eth_call', [{ to: c.to, data: c.data }, { blockHash: block.hash, requireCanonical: true }], signal);
  }
  async words(c: Call, block: Header, signal?: AbortSignal) { return words(await this.raw(c, block, signal)); }
  async code(to: string, block: Header, signal?: AbortSignal) { return this.rpc.rpc<Hex>('eth_getCode', [to, { blockHash: block.hash, requireCanonical: true }], signal); }
  /** Multicall3 with allowFailure: a failed subcall yields null, never a thrown page. */
  async multi(calls: Call[], block: Header, signal?: AbortSignal): Promise<Array<Hex | null>> {
    const out: Array<Hex | null> = [];
    for (let at = 0; at < calls.length; at += 100) {
      const chunk = calls.slice(at, at + 100);
      const data = encodeFunctionData({ abi: ABI, functionName: 'aggregate3', args: [chunk.map((c) => ({ target: c.to as Address, allowFailure: true, callData: c.data }))] });
      const raw = await this.raw({ to: MULTICALL3, data }, block, signal);
      const decoded = decodeFunctionResult({ abi: ABI, functionName: 'aggregate3', data: raw }) as readonly { success: boolean; returnData: Hex }[];
      if (decoded.length !== chunk.length) throw new FinanceError('COVERAGE_INCOMPLETE', 'Multicall returned a mismatched result count.');
      out.push(...decoded.map((r) => (r.success && r.returnData !== '0x' ? r.returnData : null)));
    }
    return out;
  }
  /**
   * A block with timestamp ≤ target and within an hour of it, by secant interpolation on
   * block timestamps (≈4 header reads on a regular chain instead of ~27 for bisection).
   */
  async blockAtOrBefore(target: bigint, head: Header, signal?: AbortSignal): Promise<Header> {
    if (BigInt(head.timestamp) <= target) return head;
    let a = BigInt(head.number), ta = BigInt(head.timestamp);
    let b = a > 1000n ? a - 1000n : 0n; let hb = await this.header(signal, b); let tb = BigInt(hb.timestamp);
    let best: Header | null = tb <= target ? hb : null;
    for (let i = 0; i < 12; i++) {
      if (best && target - BigInt(best.timestamp) <= 3600n) return best;
      if (ta === tb) break;
      let next = b + ((target - tb) * (a - b)) / (ta - tb);
      if (next < 0n) next = 0n;
      if (next >= BigInt(head.number)) next = BigInt(head.number) - 1n;
      if (next === b) { if (b === 0n) break; next = b - 1n; }
      const h = await this.header(signal, next); const t = BigInt(h.timestamp);
      if (t <= target && (!best || t > BigInt(best.timestamp))) best = h;
      a = b; ta = tb; b = next; tb = t;
    }
    if (!best) throw new FinanceError('ARCHIVE_UNAVAILABLE', 'No block found at the requested window start.');
    return best;
  }
}

export const decodeAddresses = (raw: Hex) => decodeFunctionResult({ abi: ABI, functionName: 'getReservesList', data: raw }) as readonly string[];
export const decodeSymbol = (raw: Hex | null): string | null => {
  if (!raw) return null;
  try { return (decodeFunctionResult({ abi: ABI, functionName: 'symbol', data: raw }) as string).slice(0, 40) || null; }
  catch { // bytes32 symbols (legacy tokens)
    const text = Buffer.from(raw.slice(2, 66), 'hex').toString('utf8').replace(/\0+$/, '');
    return /^[\x20-\x7e]{1,40}$/.test(text) ? text : null;
  }
};
const firstWord = (raw: Hex | null) => (raw && raw.length >= 66 ? BigInt(raw.slice(0, 66)) : null);

// ── Rate math (exact; all rates returned as Decimal fraction strings) ───────
export const aprFromRay = (ray: bigint) => rayToDecimal(ray, 6);
export const apyFromRay = (ray: bigint) => rayToDecimal(expm1Ray(ray), 6);
export const rayFromPerSecondWad = (perSecond: bigint) => perSecond * SECONDS_PER_YEAR * 10n ** 9n;
export const realizedRay = (now: bigint, then: bigint, windowSeconds: bigint) => annualiseRatio(now, then, (SECONDS_PER_YEAR * RAY) / windowSeconds);
export const fraction = (num: bigint, den: bigint) => (den === 0n ? null : rayToDecimal((num * RAY) / den, 6));

// ── Aave V3 ────────────────────────────────────────────────────────────────
export type AaveReserve = {
  asset: string; id: number; decimals: number; symbol: string | null; aToken: string; debtToken: string;
  liquidityRate: bigint; borrowRate: bigint; active: boolean; frozen: boolean; paused: boolean;
  totalSupply: bigint | null; totalDebt: bigint | null;
};
/** Pool address from the pinned PoolAddressesProvider, verified to have code at this block. */
export async function aavePool(reader: FinanceEvmReader, provider: string, block: Header, signal?: AbortSignal) {
  const pool = addr((await reader.words(call(provider, 'getPool()'), block, signal))[0]);
  if ((await reader.code(pool, block, signal)) === '0x') throw new FinanceError('CODE_DRIFT', 'Aave pool has no code at the observed block.');
  return pool;
}
export async function aaveReserves(reader: FinanceEvmReader, pool: string, block: Header, signal?: AbortSignal): Promise<AaveReserve[]> {
  const assets = decodeAddresses(await reader.raw(call(pool, 'getReservesList()'), block, signal)).map((a) => a.toLowerCase()).slice(0, 64);
  const data = await reader.multi(assets.map((a) => call(pool, 'getReserveData(address)', [a])), block, signal);
  const reserves = assets.flatMap((asset, i) => {
    const raw = data[i]; if (!raw) return [];
    const w = words(raw); const config = w[0];
    const bit = (n: number) => ((config >> BigInt(n)) & 1n) === 1n;
    return [{ asset, id: Number(w[7]), decimals: Number((config >> 48n) & 0xffn), symbol: null as string | null, aToken: addr(w[8]), debtToken: addr(w[10]),
      liquidityRate: w[2], borrowRate: w[4], active: bit(56), frozen: bit(57), paused: bit(60), totalSupply: null as bigint | null, totalDebt: null as bigint | null }];
  });
  const extra = await reader.multi(reserves.flatMap((r) => [call(r.asset, 'symbol()'), call(r.aToken, 'totalSupply()'), call(r.debtToken, 'totalSupply()')]), block, signal);
  reserves.forEach((r, i) => { r.symbol = decodeSymbol(extra[i * 3]); r.totalSupply = firstWord(extra[i * 3 + 1]); r.totalDebt = firstWord(extra[i * 3 + 2]); });
  return reserves;
}
export type AaveAccount = { collateralBase: bigint; debtBase: bigint; liquidationThresholdBps: bigint; ltvBps: bigint; healthFactor: bigint; eMode: bigint; userConfig: bigint };
export async function aaveAccount(reader: FinanceEvmReader, pool: string, user: string, block: Header, signal?: AbortSignal): Promise<AaveAccount> {
  const [acct, config, emode] = await reader.multi([call(pool, 'getUserAccountData(address)', [user]), call(pool, 'getUserConfiguration(address)', [user]), call(pool, 'getUserEMode(address)', [user])], block, signal);
  if (!acct || !config) throw new FinanceError('COVERAGE_INCOMPLETE', 'Aave account data unavailable at the observed block.');
  const w = words(acct);
  return { collateralBase: w[0], debtBase: w[1], liquidationThresholdBps: w[3], ltvBps: w[4], healthFactor: w[5], eMode: firstWord(emode) ?? 0n, userConfig: words(config)[0] };
}
export async function aaveBalances(reader: FinanceEvmReader, reserves: AaveReserve[], user: string, block: Header, signal?: AbortSignal) {
  const raw = await reader.multi(reserves.flatMap((r) => [call(r.aToken, 'balanceOf(address)', [user]), call(r.debtToken, 'balanceOf(address)', [user])]), block, signal);
  return reserves.map((r, i) => ({ reserve: r, supplied: firstWord(raw[i * 2]), debt: firstWord(raw[i * 2 + 1]) }));
}
/** Aave HF sentinel: uint256 max means no debt — never serialise it as a risk score. */
export const healthFactorDecimal = (hf: bigint) => (hf === MAX_UINT ? null : rayToDecimal(hf * 10n ** 9n, 4));
export const isCollateral = (userConfig: bigint, reserveId: number) => ((userConfig >> BigInt(reserveId * 2 + 1)) & 1n) === 1n;

// ── Morpho Blue ────────────────────────────────────────────────────────────
export const MORPHO_BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
export type MorphoMarket = { id: string; loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: bigint; totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint };
export async function morphoMarket(reader: FinanceEvmReader, id: string, block: Header, signal?: AbortSignal): Promise<MorphoMarket> {
  const [m, p] = await reader.multi([call(MORPHO_BLUE, 'market(bytes32)', [id]), call(MORPHO_BLUE, 'idToMarketParams(bytes32)', [id])], block, signal);
  if (!m || !p) throw new FinanceError('COVERAGE_INCOMPLETE', 'Morpho market unavailable at the observed block.');
  const mw = words(m), pw = words(p);
  if (pw[0] === 0n) throw new FinanceError('CAPABILITY_UNAVAILABLE', 'Morpho market id is not created.');
  return { id, loanToken: addr(pw[0]), collateralToken: addr(pw[1]), oracle: addr(pw[2]), irm: addr(pw[3]), lltv: pw[4], totalSupplyAssets: mw[0], totalSupplyShares: mw[1], totalBorrowAssets: mw[2], totalBorrowShares: mw[3], lastUpdate: mw[4], fee: mw[5] };
}
export async function morphoBorrowRatePerSecond(reader: FinanceEvmReader, m: MorphoMarket, block: Header, signal?: AbortSignal) {
  const data = encodeFunctionData({ abi: ABI, functionName: 'borrowRateView', args: [
    { loanToken: m.loanToken as Address, collateralToken: m.collateralToken as Address, oracle: m.oracle as Address, irm: m.irm as Address, lltv: m.lltv },
    { totalSupplyAssets: m.totalSupplyAssets, totalSupplyShares: m.totalSupplyShares, totalBorrowAssets: m.totalBorrowAssets, totalBorrowShares: m.totalBorrowShares, lastUpdate: m.lastUpdate, fee: m.fee },
  ] });
  return (await reader.words({ to: m.irm, data }, block, signal))[0];
}
// Morpho SharesMathLib: VIRTUAL_SHARES = 1e6, VIRTUAL_ASSETS = 1.
export const toAssetsDown = (shares: bigint, totalAssets: bigint, totalShares: bigint) => (shares * (totalAssets + 1n)) / (totalShares + 1_000_000n);
export const toAssetsUp = (shares: bigint, totalAssets: bigint, totalShares: bigint) => { const d = totalShares + 1_000_000n; return (shares * (totalAssets + 1n) + d - 1n) / d; };
export function morphoSupplyApr(borrowPerSecond: bigint, m: MorphoMarket) {
  const borrowRay = rayFromPerSecondWad(borrowPerSecond);
  if (m.totalSupplyAssets === 0n) return { borrowRay, supplyRay: 0n };
  return { borrowRay, supplyRay: (borrowRay * m.totalBorrowAssets * (WAD - m.fee)) / (m.totalSupplyAssets * WAD) };
}

// ── Kinetic (Compound-v2-style kTokens on Flare) ───────────────────────────
export type KineticMarket = { kToken: string; underlying: string | null; symbol: string | null; decimals: number | null; supplyPerSecond: bigint; borrowPerSecond: bigint; cash: bigint; borrows: bigint; reserves: bigint };
export async function kineticMarkets(reader: FinanceEvmReader, kTokens: string[], block: Header, signal?: AbortSignal) {
  const per = ['supplyRatePerTimestamp()', 'borrowRatePerTimestamp()', 'getCash()', 'totalBorrows()', 'totalReserves()', 'underlying()'];
  const raw = await reader.multi(kTokens.flatMap((k) => per.map((sig) => call(k, sig))), block, signal);
  const markets: KineticMarket[] = []; const failed: string[] = [];
  kTokens.forEach((kToken, i) => {
    const r = raw.slice(i * per.length, (i + 1) * per.length).map(firstWord);
    if (r.slice(0, 5).some((v) => v === null)) { failed.push(kToken); return; }
    markets.push({ kToken, underlying: r[5] === null ? null : addr(r[5]), symbol: null, decimals: null, supplyPerSecond: r[0]!, borrowPerSecond: r[1]!, cash: r[2]!, borrows: r[3]!, reserves: r[4]! });
  });
  const meta = await reader.multi(markets.flatMap((m) => m.underlying ? [call(m.underlying, 'symbol()'), call(m.underlying, 'decimals()')] : [call(m.kToken, 'symbol()'), call(m.kToken, 'decimals()')]), block, signal);
  markets.forEach((m, i) => {
    if (!m.underlying) { m.symbol = 'FLR'; m.decimals = 18; return; } // native market: the kToken symbol (kFLR) is not the lent asset
    m.symbol = decodeSymbol(meta[i * 2]); const d = firstWord(meta[i * 2 + 1]); m.decimals = d === null || d > 36n ? null : Number(d);
  });
  return { markets, failed };
}

// ── ERC-4626 vaults (realised trailing yield) ──────────────────────────────
export async function vaultSharePrice(reader: FinanceEvmReader, vault: string, block: Header, signal?: AbortSignal) {
  const [dec, asset] = await reader.multi([call(vault, 'decimals()'), call(vault, 'asset()')], block, signal);
  const decimals = firstWord(dec); if (decimals === null || decimals > 36n) throw new FinanceError('CAPABILITY_UNAVAILABLE', 'Vault decimals unavailable.');
  const [pps] = await reader.multi([call(vault, 'convertToAssets(uint256)', [10n ** decimals])], block, signal);
  const price = firstWord(pps); if (price === null) throw new FinanceError('CAPABILITY_UNAVAILABLE', 'Vault share price unavailable.');
  return { price, decimals: Number(decimals), asset: asset ? addr(BigInt(asset.slice(0, 66))) : null };
}

// ── Flare yield tokens (liquid staking / non-4626 vaults) ──────────────────
/**
 * Each reader returns a share price now and at (or near) window start, in one scale per token.
 * Firelight and Sceptre keep price history in contract storage, so both ends come from the
 * SAME pinned head block (no archive). Upshift exposes only a current price → past block (archive).
 */
export type YieldKind = 'firelight' | 'sceptre' | 'upshift';
export type YieldReading = { now: bigint; then: bigint | null; thenAt: number | null; past: Header | null; asset: string | null; native: boolean };
export async function firelightReading(reader: FinanceEvmReader, vault: string, head: Header, windowSeconds: number, signal?: AbortSignal): Promise<YieldReading> {
  const tNow = BigInt(head.timestamp) - 1n, tThen = BigInt(head.timestamp) - BigInt(windowSeconds);
  const r = await reader.multi([call(vault, 'totalAssetsAt(uint48)', [tNow]), call(vault, 'totalSupplyAt(uint48)', [tNow]), call(vault, 'totalAssetsAt(uint48)', [tThen]), call(vault, 'totalSupplyAt(uint48)', [tThen]), call(vault, 'asset()')], head, signal);
  const [an, sn, at, st, asset] = r.map(firstWord);
  if (!an || !sn) throw new FinanceError('CAPABILITY_UNAVAILABLE', 'Firelight checkpoint unavailable.');
  const ok = at !== null && st !== null && st > 0n;
  return { now: (an * WAD) / sn, then: ok ? (at! * WAD) / st! : null, thenAt: ok ? Number(tThen) : null, past: null, asset: asset === null ? null : addr(asset), native: false };
}
/** Out-of-bounds reads of Sceptre's history array exhaust gas (and fail a whole multicall), so probe one index at a time. */
const historyLength = new Map<string, bigint>();
async function sceptreHistoryLength(reader: FinanceEvmReader, token: string, head: Header, signal?: AbortSignal): Promise<bigint> {
  const has = async (i: bigint) => { try { return firstWord(await reader.raw(call(token, 'historicalExchangeRateTimestamps(uint256)', [i]), head, signal)) !== null; } catch { return false; } };
  let lo = historyLength.get(token) ?? 0n; // entries only ever get appended
  if (lo > 0n && !(await has(lo - 1n))) lo = 0n;
  if (lo === 0n && !(await has(0n))) return 0n;
  if (lo === 0n) lo = 1n;
  let step = 1n; while (step < 4096n && (await has(lo + step - 1n))) { lo += step; step *= 2n; } // lo = count known to exist
  let hi = lo + step - 1n; // first index known (or assumed) missing
  while (hi - lo > 0n) { const mid = (lo + hi) / 2n; if (await has(mid)) lo = mid + 1n; else hi = mid; }
  historyLength.set(token, lo);
  return lo;
}
export async function sceptreReading(reader: FinanceEvmReader, token: string, head: Header, windowSeconds: number, signal?: AbortSignal): Promise<YieldReading> {
  const [nowRaw] = await reader.multi([call(token, 'getPooledFlrByShares(uint256)', [WAD])], head, signal);
  const now = firstWord(nowRaw); if (!now) throw new FinanceError('CAPABILITY_UNAVAILABLE', 'sFLR exchange rate unavailable.');
  const length = await sceptreHistoryLength(reader, token, head, signal);
  const from = length > 32n ? length - 32n : 0n;
  const idx = Array.from({ length: Number(length - from) }, (_, i) => from + BigInt(i));
  const stamps = (await reader.multi(idx.map((i) => call(token, 'historicalExchangeRateTimestamps(uint256)', [i])), head, signal)).map(firstWord)
    .filter((t): t is bigint => t !== null && t > 0n && t < BigInt(head.timestamp));
  if (!stamps.length) return { now, then: null, thenAt: null, past: null, asset: null, native: true };
  const target = BigInt(head.timestamp) - BigInt(windowSeconds);
  const before = stamps.filter((t) => t <= target);
  const pick = before.length ? before.reduce((x, y) => (y > x ? y : x)) : stamps.reduce((x, y) => (y < x ? y : x));
  const [rate] = await reader.multi([call(token, 'historicalExchangeRatesByTimestamp(uint256)', [pick])], head, signal);
  const then = firstWord(rate);
  return { now, then: then || null, thenAt: then ? Number(pick) : null, past: null, asset: null, native: true };
}
export async function upshiftReading(reader: FinanceEvmReader, vault: string, head: Header, past: Header | null, signal?: AbortSignal): Promise<YieldReading & { updatedAt: number | null }> {
  const [p, a, u] = (await reader.multi([call(vault, 'getSharePrice()'), call(vault, 'asset()'), call(vault, 'assetsUpdatedOn()')], head, signal)).map(firstWord);
  if (!p) throw new FinanceError('CAPABILITY_UNAVAILABLE', 'Upshift share price unavailable.');
  let then: bigint | null = null;
  if (past) { const [q] = await reader.multi([call(vault, 'getSharePrice()')], past, signal); then = firstWord(q) || null; }
  return { now: p, then, thenAt: then && past ? Number(BigInt(past.timestamp)) : null, past: then ? past : null, asset: a === null ? null : addr(a), native: false, updatedAt: u === null ? null : Number(u) };
}
