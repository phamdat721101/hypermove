import type { Header } from '../evm';
import type { XrplReader } from '../xrpl';
import { XRPFI_VENUES } from '../../xrpfi-sources';
import { FinanceError, RATES_CONTRACT_DIGEST, normalizeEvmAddress, rayToDecimal, assertWireResponse, type RatesNetwork } from './contracts';
import {
  FinanceEvmReader, aavePool, aaveReserves, aprFromRay, apyFromRay, fraction, kineticMarkets, morphoBorrowRatePerSecond, morphoMarket,
  morphoSupplyApr, rayFromPerSecondWad, realizedRay, sha256, vaultSharePrice, decodeSymbol, evmObservation as sharedEvmObservation, type EvmNet,
  firelightReading, sceptreReading, upshiftReading, type YieldKind, type YieldReading,
} from './adapters';
import { amendmentEnabled, brokerRateRange, operatorObjects, validatedLedger, vaultShareValue, xrplAsset, xrplNetworkIdentity, xrplRealized, type Ledger } from './xrpl-read';

export type RatesConfig = {
  aaveProviders: Partial<Record<'arbitrum' | 'base', string>>;
  morphoMarkets: Partial<Record<'base', string[]>>;
  morphoIrmAllowlist: string[];
  kineticMarkets: string[];
  vaults4626: string[];
  xrplVaults: string[];
  xrplBrokers: string[];
  /** XRPL accounts whose owned Vault/LoanBroker objects are discovered at the pinned ledger. */
  xrplOperators?: string[];
  /** Flare liquid-staking / non-4626 vault tokens, `kind:address`. */
  yieldTokens?: Array<{ kind: YieldKind; address: string }>;
  archive: Partial<Record<RatesNetwork, boolean>>;
  windowSeconds: number;
};
const list = (raw: string | undefined, evm = true) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => (evm ? normalizeEvmAddress(s) : s.toUpperCase())).slice(0, 32);
const YIELD_KINDS: YieldKind[] = ['firelight', 'sceptre', 'upshift'];
const YIELD_NAMES: Record<YieldKind, string> = { firelight: 'Firelight', sceptre: 'Sceptre', upshift: 'Upshift' };
export function ratesConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RatesConfig {
  const opt = (k: string) => (env[k] ? normalizeEvmAddress(env[k]!) : undefined);
  return {
    aaveProviders: { arbitrum: opt('FINANCE_AAVE_ARBITRUM_PROVIDER'), base: opt('FINANCE_AAVE_BASE_PROVIDER') },
    morphoMarkets: { base: (env.FINANCE_MORPHO_BASE_MARKETS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{64}$/.test(s)).slice(0, 16) },
    morphoIrmAllowlist: list(env.FINANCE_MORPHO_IRM_ALLOWLIST),
    kineticMarkets: list(env.FINANCE_FLARE_KINETIC_MARKETS),
    vaults4626: list(env.FINANCE_FLARE_4626_VAULTS),
    xrplVaults: list(env.FINANCE_XRPL_VAULTS, false).filter((s) => /^[A-F0-9]{64}$/.test(s)),
    xrplBrokers: list(env.FINANCE_XRPL_LOANBROKERS, false).filter((s) => /^[A-F0-9]{64}$/.test(s)),
    xrplOperators: (env.FINANCE_XRPL_OPERATORS ?? '').split(',').map((s) => s.trim()).filter((s) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s)).slice(0, 16),
    yieldTokens: (env.FINANCE_FLARE_YIELD_TOKENS ?? '').split(',').map((s) => s.trim().split(':')).filter(([k, a]) => YIELD_KINDS.includes(k as YieldKind) && /^0x[0-9a-fA-F]{40}$/.test(a ?? ''))
      .map(([k, a]) => ({ kind: k as YieldKind, address: normalizeEvmAddress(a) })).slice(0, 16),
    archive: { arbitrum: env.FINANCE_ARBITRUM_ARCHIVE === 'true', base: env.FINANCE_BASE_ARCHIVE === 'true', flare: env.FINANCE_FLARE_ARCHIVE === 'true', xrpl: env.FINANCE_XRPL_ARCHIVE === 'true' },
    windowSeconds: Math.max(86_400, Math.min(30 * 86_400, Number(env.FINANCE_RATE_WINDOW_SECONDS ?? 7 * 86_400) || 7 * 86_400)),
  };
}

export type RatesDeps = { evm: Partial<Record<EvmNet, FinanceEvmReader>>; xrpl?: XrplReader; config: RatesConfig; clock: () => number };
type Row = Record<string, unknown> & { rateKind: string; supplyApy: string | null; borrowApy: string | null; assetLabel: string; network: string };
type Missing = { capability: string; reasonCode: string };
type VenueResult = { rows: Row[]; missing: Missing[] };

const TTL_MS = 15_000;
const cache = new Map<string, { expires: number; value: VenueResult }>();
export const clearRatesCache = () => cache.clear();

const iso = (ms: number) => new Date(ms).toISOString();
const evidence = (source: unknown, content: unknown, expiresAt: string | null) => ({ id: sha256(source), contentHash: sha256(content), expiresAt });
const evmObservation = (network: EvmNet, block: Header, now: number, source: unknown) => sharedEvmObservation(network, block, now, TTL_MS, source);
function xrplObservation(identity: string, ledger: Ledger, now: number, source: unknown) {
  return {
    network: 'xrpl', networkIdentityHash: identity, point: { kind: 'xrpl-ledger', index: String(ledger.index), hash: ledger.hash, validated: true },
    observedAt: iso(now), expiresAt: iso(now + TTL_MS), consistency: 'pinned', fidelity: 'chain-read', sources: [evidence(source, { ledger: ledger.hash }, iso(now + TTL_MS))],
  };
}
const evmPoint = (b: Header) => ({ kind: 'evm-block', number: BigInt(b.number).toString(), hash: b.hash.toLowerCase(), finality: 'included' });
const erc20 = (network: EvmNet, address: string, decimals: number | null) => (decimals === null || decimals > 36 ? null : { kind: 'erc20', network, address: address.toLowerCase(), decimals });
const amount = (asset: Record<string, unknown> | null, value: bigint | null) => (asset && value !== null && value >= 0n ? { asset, quantity: { kind: 'atomic', value: value.toString() } } : null);
const bridged = (network: string, label: string) => network === 'flare' && /XRP/i.test(label);
const base = (r: Partial<Row>): Row => ({ range: null, window: null, utilization: null, totalSupplied: null, totalBorrowed: null, supplyApr: null, borrowApr: null, supplyApy: null, borrowApy: null, caveats: [], ...r } as Row);

async function cached(key: string, now: number, load: () => Promise<VenueResult>): Promise<VenueResult> {
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = await load();
  cache.set(key, { expires: now + TTL_MS, value });
  return value;
}
const missingFrom = (capability: string, e: unknown): Missing => ({ capability, reasonCode: e instanceof FinanceError ? e.code : 'DEPENDENCY_TIMEOUT' });

// ── Venue loaders (each isolated: failure → coverage.missing for that venue only) ──
async function aaveRates(network: 'arbitrum' | 'base', reader: FinanceEvmReader, provider: string, now: number, signal?: AbortSignal): Promise<VenueResult> {
  const block = await reader.header(signal);
  const pool = await aavePool(reader, provider, block, signal);
  const reserves = await aaveReserves(reader, pool, block, signal);
  const observation = evmObservation(network, block, now, { venue: 'aave-v3', network, pool });
  const rows = reserves.filter((r) => r.active).map((r) => {
    const asset = erc20(network, r.asset, r.decimals);
    const label = r.symbol ?? 'UNKNOWN';
    return base({
      marketId: sha256(['aave-v3', network, r.asset]), network, venue: 'aave-v3', venueName: 'Aave V3', venueRef: { marketKey: sha256([pool, r.asset]), address: pool },
      asset, assetLabel: label, requiresBridge: false, rateKind: 'posted-variable',
      supplyApr: aprFromRay(r.liquidityRate), borrowApr: aprFromRay(r.borrowRate), supplyApy: apyFromRay(r.liquidityRate), borrowApy: apyFromRay(r.borrowRate),
      utilization: r.totalSupply && r.totalDebt !== null ? fraction(r.totalDebt, r.totalSupply) : null,
      totalSupplied: amount(asset, r.totalSupply), totalBorrowed: amount(asset, r.totalDebt), observation,
      caveats: [...(r.frozen ? ['reserve frozen: no new supply/borrow'] : []), ...(r.paused ? ['reserve paused'] : []), 'APY assumes continuous compounding of the current variable rate'],
    });
  });
  return { rows, missing: [] };
}
async function morphoRates(reader: FinanceEvmReader, ids: string[], irms: string[], now: number, signal?: AbortSignal): Promise<VenueResult> {
  const block = await reader.header(signal);
  const rows: Row[] = []; const missing: Missing[] = [];
  for (const id of ids) {
    try {
      const m = await morphoMarket(reader, id, block, signal);
      if (!irms.includes(m.irm)) throw new FinanceError('FEATURE_STATE_UNKNOWN', 'IRM not on the reviewed allowlist.');
      const perSecond = await morphoBorrowRatePerSecond(reader, m, block, signal);
      const { borrowRay, supplyRay } = morphoSupplyApr(perSecond, m);
      const [sym, dec] = await reader.multi([{ to: m.loanToken, data: '0x95d89b41' }, { to: m.loanToken, data: '0x313ce567' }], block, signal);
      const decimals = dec ? Number(BigInt(dec.slice(0, 66))) : null;
      const asset = erc20('base', m.loanToken, decimals);
      rows.push(base({
        marketId: sha256(['morpho-blue', 'base', id]), network: 'base', venue: 'morpho-blue', venueName: 'Morpho Blue', venueRef: { marketKey: id.slice(2), address: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' },
        asset, assetLabel: decodeSymbol(sym) ?? 'UNKNOWN', requiresBridge: false, rateKind: 'posted-variable',
        supplyApr: aprFromRay(supplyRay), borrowApr: aprFromRay(borrowRay), supplyApy: apyFromRay(supplyRay), borrowApy: apyFromRay(borrowRay),
        utilization: fraction(m.totalBorrowAssets, m.totalSupplyAssets), totalSupplied: amount(asset, m.totalSupplyAssets), totalBorrowed: amount(asset, m.totalBorrowAssets),
        observation: evmObservation('base', block, now, { venue: 'morpho-blue', id }),
        caveats: ['totals exclude interest accrued since the market last updated', `LLTV ${rayToDecimal(m.lltv * 10n ** 9n, 4)}`],
      }));
    } catch (e) { missing.push(missingFrom('base.morpho-blue:' + id.slice(0, 10), e)); }
  }
  return { rows, missing };
}
async function kineticRates(reader: FinanceEvmReader, kTokens: string[], now: number, signal?: AbortSignal): Promise<VenueResult> {
  const block = await reader.header(signal);
  const { markets, failed } = await kineticMarkets(reader, kTokens, block, signal);
  const rows = markets.map((m) => {
    const supplyRay = rayFromPerSecondWad(m.supplyPerSecond), borrowRay = rayFromPerSecondWad(m.borrowPerSecond);
    const asset = m.underlying ? erc20('flare', m.underlying, m.decimals) : null;
    const label = m.symbol ?? 'UNKNOWN';
    const supplied = m.cash + m.borrows - m.reserves;
    return base({
      marketId: sha256(['kinetic', 'flare', m.kToken]), network: 'flare', venue: 'kinetic', venueName: 'Kinetic', venueRef: { address: m.kToken },
      asset, assetLabel: label, requiresBridge: bridged('flare', label), rateKind: 'posted-variable',
      supplyApr: aprFromRay(supplyRay), borrowApr: aprFromRay(borrowRay), supplyApy: apyFromRay(supplyRay), borrowApy: apyFromRay(borrowRay),
      utilization: supplied > 0n ? fraction(m.borrows, supplied) : null, totalSupplied: amount(asset, supplied), totalBorrowed: amount(asset, m.borrows),
      observation: evmObservation('flare', block, now, { venue: 'kinetic', kToken: m.kToken }),
      caveats: [...(m.underlying ? [] : ['native-asset market: underlying asset is FLR']), 'per-second rate annualised'],
    });
  });
  return { rows, missing: failed.map((k) => ({ capability: 'flare.kinetic:' + k.slice(0, 10), reasonCode: 'CAPABILITY_UNAVAILABLE' })) };
}
async function vaultRates(reader: FinanceEvmReader, vaults: string[], archive: boolean, windowSeconds: number, now: number, signal?: AbortSignal): Promise<VenueResult> {
  const head = await reader.header(signal);
  const rows: Row[] = []; const missing: Missing[] = [];
  let past: Header | null = null;
  if (archive) {
    try { past = await reader.blockAtOrBefore(BigInt(head.timestamp) - BigInt(windowSeconds), head, signal); } catch (e) { missing.push(missingFrom('flare.erc4626-vault.window', e)); }
  } else missing.push({ capability: 'flare.erc4626-vault.window', reasonCode: 'ARCHIVE_UNAVAILABLE' });
  for (const vault of vaults) {
    try {
      const now0 = await vaultSharePrice(reader, vault, head, signal);
      const [sym] = await reader.multi([{ to: vault, data: '0x95d89b41' }], head, signal);
      const label = decodeSymbol(sym) ?? 'UNKNOWN';
      let realized: string | null = null; let window: unknown = null; const caveats = ['realised trailing yield: past performance, not a quoted or promised rate'];
      if (past) {
        try {
          const then = await vaultSharePrice(reader, vault, past, signal);
          const seconds = Number(BigInt(head.timestamp) - BigInt(past.timestamp));
          realized = rayToDecimal(realizedRay(now0.price, then.price, BigInt(seconds)), 6);
          window = { fromPoint: evmPoint(past), toPoint: evmPoint(head), seconds };
          if (now0.price < then.price) caveats.push('share price decreased over the window');
        } catch { caveats.push('vault did not exist or was unreadable at window start'); }
      }
      rows.push(base({
        marketId: sha256(['erc4626', 'flare', vault]), network: 'flare', venue: 'erc4626-vault', venueName: label, venueRef: { address: vault },
        asset: now0.asset ? erc20('flare', now0.asset, null) : null, assetLabel: label, requiresBridge: bridged('flare', label), rateKind: 'realized-trailing',
        supplyApy: realized, window, observation: evmObservation('flare', head, now, { venue: 'erc4626', vault }), caveats,
      }));
    } catch (e) { missing.push(missingFrom('flare.erc4626-vault:' + vault.slice(0, 10), e)); }
  }
  return { rows, missing };
}
async function yieldTokenRates(reader: FinanceEvmReader, tokens: Array<{ kind: YieldKind; address: string }>, archive: boolean, windowSeconds: number, now: number, signal?: AbortSignal): Promise<VenueResult> {
  const head = await reader.header(signal);
  const rows: Row[] = []; const missing: Missing[] = [];
  let past: Header | null = null;
  if (tokens.some((t) => t.kind === 'upshift')) {
    if (archive) { try { past = await reader.blockAtOrBefore(BigInt(head.timestamp) - BigInt(windowSeconds), head, signal); } catch (e) { missing.push(missingFrom('flare.yield-token.window', e)); } }
    else missing.push({ capability: 'flare.yield-token.upshift-window', reasonCode: 'ARCHIVE_UNAVAILABLE' });
  }
  for (const t of tokens) {
    try {
      const r: YieldReading & { updatedAt?: number | null } = t.kind === 'firelight' ? await firelightReading(reader, t.address, head, windowSeconds, signal)
        : t.kind === 'sceptre' ? await sceptreReading(reader, t.address, head, windowSeconds, signal) : await upshiftReading(reader, t.address, head, past, signal);
      const [sym, dec, assetSym] = await reader.multi([{ to: t.address, data: '0x95d89b41' }, ...(r.asset ? [{ to: r.asset, data: '0x313ce567' as const }, { to: r.asset, data: '0x95d89b41' as const }] : [])], head, signal);
      const label = decodeSymbol(sym) ?? (assetSym ? `${decodeSymbol(assetSym)} vault` : 'UNKNOWN'); // Upshift share tokens expose no symbol()
      const decimals = dec ? Number(BigInt(dec.slice(0, 66))) : null;
      const asset = r.native ? { kind: 'evm-native', network: 'flare', decimals: 18 } : r.asset ? erc20('flare', r.asset, decimals) : null;
      const caveats = ['realised trailing yield: past performance, not a quoted or promised rate'];
      let realized: string | null = null; let window: unknown = null;
      const seconds = r.thenAt === null ? 0 : Number(BigInt(head.timestamp)) - r.thenAt;
      if (r.then !== null && seconds > 0) {
        realized = rayToDecimal(realizedRay(r.now, r.then, BigInt(seconds)), 6);
        window = { fromPoint: evmPoint(r.past ?? head), toPoint: evmPoint(head), seconds };
        if (!r.past) caveats.push(`window start value read from the contract's on-chain price history at ${iso(r.thenAt! * 1000)}, inside the pinned block`);
        if (seconds < windowSeconds * 0.9) caveats.push(`history covers only ${Math.round(seconds / 86_400 * 10) / 10} days of the requested window`);
        if (r.now < r.then) caveats.push('share price decreased over the window');
      } else caveats.push('no price history for the window yet');
      if (t.kind === 'upshift' && r.updatedAt) caveats.push(`share price is updated off-chain periodically; last update ${iso(r.updatedAt * 1000)}`);
      if (t.kind === 'sceptre') caveats.push('FLR staking yield; unstaking has a cooldown');
      rows.push(base({
        marketId: sha256(['yield-token', 'flare', t.address]), network: 'flare', venue: 'yield-token', venueName: `${YIELD_NAMES[t.kind]} ${label}`.slice(0, 80), venueRef: { address: t.address },
        asset, assetLabel: label, requiresBridge: bridged('flare', label), rateKind: 'realized-trailing', supplyApy: realized, window,
        observation: evmObservation('flare', head, now, { venue: 'yield-token', kind: t.kind, token: t.address }), caveats,
      }));
    } catch (e) { missing.push(missingFrom(`flare.yield-token:${t.kind}:${t.address.slice(0, 10)}`, e)); }
  }
  return { rows, missing };
}
async function xrplRates(reader: XrplReader, config: RatesConfig, now: number, signal?: AbortSignal): Promise<VenueResult> {
  const ledger = await validatedLedger(reader, signal);
  const identity = await xrplNetworkIdentity(reader, signal);
  const rows: Row[] = []; const missing: Missing[] = [];
  const operators = config.xrplOperators ?? [];
  const vaultOn = config.xrplVaults.length || operators.length ? await amendmentEnabled(reader, 'SingleAssetVault', signal) : false;
  const lendingOn = config.xrplBrokers.length || operators.length ? await amendmentEnabled(reader, 'LendingProtocol', signal) : false;
  if ((config.xrplVaults.length || operators.length) && vaultOn !== true) missing.push({ capability: 'xrpl.vault', reasonCode: 'FEATURE_STATE_UNKNOWN' });
  if ((config.xrplBrokers.length || operators.length) && lendingOn !== true) missing.push({ capability: 'xrpl.loanbroker', reasonCode: 'FEATURE_STATE_UNKNOWN' });
  const vaultIds = new Set(config.xrplVaults); const brokerIds = new Set(config.xrplBrokers);
  if (operators.length && (vaultOn === true || lendingOn === true)) {
    const found = await operatorObjects(reader, operators, ledger, signal);
    found.vaults.forEach((id) => vaultIds.add(id)); found.brokers.forEach((id) => brokerIds.add(id));
    missing.push(...found.failed.map((a) => ({ capability: 'xrpl.operator:' + a.slice(0, 8), reasonCode: 'CAPABILITY_UNAVAILABLE' })));
  }
  if (vaultOn === true) {
    let past: Ledger | null = null;
    if (config.archive.xrpl) {
      try { past = await validatedLedger(reader, signal, Math.max(1, ledger.index - Math.ceil(config.windowSeconds / 4))); } catch (e) { missing.push(missingFrom('xrpl.vault.window', e)); }
    } else missing.push({ capability: 'xrpl.vault.window', reasonCode: 'ARCHIVE_UNAVAILABLE' });
    for (const id of [...vaultIds].slice(0, 32)) {
      try {
        const nowV = await vaultShareValue(reader, id, ledger, signal);
        let realized: string | null = null; let window: unknown = null;
        if (past && nowV.value !== null) {
          try {
            const thenV = await vaultShareValue(reader, id, past, signal);
            const seconds = ledger.closeTime - past.closeTime;
            if (thenV.value !== null && seconds > 0) {
              realized = xrplRealized(nowV.value, thenV.value, seconds);
              window = { fromPoint: { kind: 'xrpl-ledger', index: String(past.index), hash: past.hash, validated: true }, toPoint: { kind: 'xrpl-ledger', index: String(ledger.index), hash: ledger.hash, validated: true }, seconds };
            }
          } catch { /* vault absent at window start → realised stays null */ }
        }
        const { asset, label } = xrplAsset(nowV.vault.Asset);
        rows.push(base({
          marketId: sha256(['xrpl-vault', id]), network: 'xrpl', venue: 'xrpl-vault', venueName: 'XRPL Vault ' + id.slice(0, 8), venueRef: { ledgerObjectId: id },
          asset, assetLabel: label, requiresBridge: false, rateKind: 'realized-trailing',
          supplyApy: realized, window, observation: xrplObservation(identity, ledger, now, { venue: 'xrpl-vault', id }),
          caveats: ['XLS-65 share value change over the window; not an offered rate', ...(nowV.value === null ? ['vault has no outstanding shares'] : [])],
        }));
      } catch (e) { missing.push(missingFrom('xrpl.vault:' + id.slice(0, 8), e)); }
    }
  }
  if (lendingOn === true) {
    for (const id of [...brokerIds].slice(0, 32)) {
      try {
        const { range, asset, truncated } = await brokerRateRange(reader, id, ledger, signal);
        if (!range) missing.push({ capability: 'xrpl.loanbroker:' + id.slice(0, 8), reasonCode: 'NO_ACTIVE_LOANS' });
        rows.push(base({
          marketId: sha256(['xrpl-loanbroker', id]), network: 'xrpl', venue: 'xrpl-loanbroker', venueName: 'XRPL LoanBroker ' + id.slice(0, 8), venueRef: { ledgerObjectId: id },
          asset: asset.asset, assetLabel: asset.label, requiresBridge: false, rateKind: 'observed-loan-range', range,
          observation: xrplObservation(identity, ledger, now, { venue: 'xrpl-loanbroker', id }),
          caveats: ['XLS-66 rates are negotiated per loan; this is the observed range of active loans, not an offer', ...(truncated ? ['range sampled from the first 100 loans'] : [])],
        }));
      } catch (e) { missing.push(missingFrom('xrpl.loanbroker:' + id.slice(0, 8), e)); }
    }
  }
  return { rows, missing };
}
function documentedRows(now: number): { rows: Row[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows = XRPFI_VENUES.map((v) => {
    const ageDays = (now - Date.parse(v.date + 'T00:00:00.000Z')) / 86_400_000;
    if (ageDays > 30) warnings.push(`STALE_DOCUMENTED: ${v.name} figures are from ${v.date}`);
    const single = /^~?\s*(\d+(?:\.\d+)?)%/.exec(v.rateApprox);
    const ambiguous = !single || /[·\-–]/.test(v.rateApprox);
    const network = v.requiresBridge ? 'flare' : 'xrpl';
    return base({
      marketId: sha256(['documented', v.name]), network, venue: 'documented', venueName: v.name, venueRef: { url: v.source },
      asset: null, assetLabel: v.assets.join('/').slice(0, 40), requiresBridge: v.requiresBridge, rateKind: 'documented-headline',
      supplyApy: ambiguous ? null : rayToDecimal((BigInt(Math.round(Number(single![1]) * 100)) * 10n ** 27n) / 10000n, 4),
      observation: { fidelity: 'documented', sourceUrl: v.source, sourceDate: v.date, observedAt: iso(now) },
      caveats: [`headline: ${v.rateApprox}`.slice(0, 300), `lock-up: ${v.lockup}`.slice(0, 300), 'curated off-chain figure; verify in-app before depositing'],
    });
  });
  return { rows, warnings };
}

const KIND_ORDER = ['posted-variable', 'realized-trailing', 'observed-loan-range', 'documented-headline'];
const num = (s: string | null) => (s === null ? -Infinity : Number(s));

/** Lending rates across admitted venues. Never ranks across rate kinds or fidelity. */
export async function lendingRates(request: Record<string, unknown>, deps: RatesDeps, signal?: AbortSignal) {
  const now = deps.clock();
  const networks = request.networks as RatesNetwork[];
  const side = request.side as 'supply' | 'borrow' | 'both';
  const symbols = (request.assets as Array<{ symbol: string }> | null)?.map((a) => a.symbol.toUpperCase()) ?? null;
  const { config } = deps;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const deadline = controller.signal;
  const jobs: Array<[string, () => Promise<VenueResult>]> = [];
  const need = (network: RatesNetwork, venue: string, configured: boolean, reader: unknown) => {
    if (!networks.includes(network) || !configured) return false;
    if (!reader) { jobs.push([`${network}.${venue}`, async () => ({ rows: [], missing: [{ capability: `${network}.${venue}`, reasonCode: 'CAPABILITY_UNAVAILABLE' }] })]); return false; }
    return true;
  };
  for (const net of ['arbitrum', 'base'] as const) {
    const provider = config.aaveProviders[net];
    if (need(net, 'aave-v3', Boolean(provider), deps.evm[net])) jobs.push([`${net}.aave-v3`, () => cached(`${net}:aave:${provider}`, now, () => aaveRates(net, deps.evm[net]!, provider!, now, deadline))]);
  }
  const morpho = config.morphoMarkets.base ?? [];
  if (need('base', 'morpho-blue', morpho.length > 0, deps.evm.base)) jobs.push(['base.morpho-blue', () => cached(`base:morpho:${morpho.join()}`, now, () => morphoRates(deps.evm.base!, morpho, config.morphoIrmAllowlist, now, deadline))]);
  if (need('flare', 'kinetic', config.kineticMarkets.length > 0, deps.evm.flare)) jobs.push(['flare.kinetic', () => cached(`flare:kinetic:${config.kineticMarkets.join()}`, now, () => kineticRates(deps.evm.flare!, config.kineticMarkets, now, deadline))]);
  if (need('flare', 'erc4626-vault', config.vaults4626.length > 0, deps.evm.flare)) jobs.push(['flare.erc4626-vault', () => cached(`flare:4626:${config.vaults4626.join()}:${config.archive.flare}`, now, () => vaultRates(deps.evm.flare!, config.vaults4626, Boolean(config.archive.flare), config.windowSeconds, now, deadline))]);
  const yieldTokens = config.yieldTokens ?? [];
  if (need('flare', 'yield-token', yieldTokens.length > 0, deps.evm.flare)) jobs.push(['flare.yield-token', () => cached(`flare:yield:${yieldTokens.map((t) => t.kind + t.address).join()}:${config.archive.flare}`, now, () => yieldTokenRates(deps.evm.flare!, yieldTokens, Boolean(config.archive.flare), config.windowSeconds, now, deadline))]);
  const operators = config.xrplOperators ?? [];
  if (need('xrpl', 'native', config.xrplVaults.length + config.xrplBrokers.length + operators.length > 0, deps.xrpl)) jobs.push(['xrpl.native', () => cached(`xrpl:${config.xrplVaults.join()}:${config.xrplBrokers.join()}:${operators.join()}:${config.archive.xrpl}`, now, () => xrplRates(deps.xrpl!, config, now, deadline))]);

  const settled = await Promise.allSettled(jobs.map(([, run]) => run())).finally(() => clearTimeout(timer));
  let rows: Row[] = []; const missing: Missing[] = []; const warnings: string[] = [];
  settled.forEach((s, i) => { if (s.status === 'fulfilled') { rows.push(...s.value.rows); missing.push(...s.value.missing); } else missing.push(missingFrom(jobs[i][0], s.reason)); });
  for (const net of networks) if (!jobs.some(([k]) => k.startsWith(net + '.'))) missing.push({ capability: `${net}.lending-rates`, reasonCode: 'CAPABILITY_UNAVAILABLE' });
  if (request.includeDocumented === true) { const d = documentedRows(now); rows.push(...d.rows.filter((r) => networks.includes(r.network as RatesNetwork))); warnings.push(...d.warnings); }

  if (symbols) rows = rows.filter((r) => symbols.some((s) => r.assetLabel.toUpperCase().includes(s)) || r.venue === 'xrpl-loanbroker');
  if (side === 'supply') rows = rows.map((r) => ({ ...r, borrowApr: null, borrowApy: null })).filter((r) => r.supplyApy !== null || r.rateKind !== 'posted-variable');
  if (side === 'borrow') rows = rows.filter((r) => r.borrowApy !== null || r.rateKind === 'observed-loan-range').map((r) => ({ ...r, supplyApr: null, supplyApy: null }));
  const key = side === 'borrow' ? 'borrowApy' : 'supplyApy';
  rows.sort((a, b) => KIND_ORDER.indexOf(a.rateKind) - KIND_ORDER.indexOf(b.rateKind) || num(b[key] as string | null) - num(a[key] as string | null));
  rows = rows.slice(0, 200);

  const response = {
    schemaVersion: 'finance.rates.response/1', ratesContractDigest: RATES_CONTRACT_DIGEST, requestId: request.requestId, execution: false,
    status: missing.length ? 'partial' : 'success', kind: 'lending-rates', data: { markets: rows },
    coverage: { complete: missing.length === 0, missing: missing.slice(0, 100), cursor: null }, warnings: warnings.slice(0, 20), errors: [],
  };
  assertWireResponse(response, 'rates');
  return response;
}

const pct = (s: string | null) => (s === null ? 'n/a' : `${(Number(s) * 100).toFixed(2)}%`);
/** Deterministic, non-authoritative text rendering of a rates response (no LLM). */
export function ratesSummary(response: Record<string, unknown>): string {
  const r = response as unknown as { data: { markets: Row[] }; coverage: { missing: Missing[] }; warnings: string[] };
  const lines = ['Summary (non-authoritative) — lending rates, read-only:'];
  for (const kind of KIND_ORDER) {
    const group = r.data.markets.filter((m) => m.rateKind === kind);
    if (!group.length) continue;
    lines.push(`[${kind}]`);
    for (const m of group.slice(0, 12)) {
      const range = m.range as { min: string; median: string; max: string; sampleSize: number } | null;
      const rate = range ? `${pct(range.min)}–${pct(range.max)} (median ${pct(range.median)}, ${range.sampleSize} loans)` : `supply ${pct(m.supplyApy)} · borrow ${pct(m.borrowApy)}`;
      lines.push(`- ${m.assetLabel} · ${m.venueName} (${m.network}): ${rate}${m.requiresBridge ? ' · needs XRP→FXRP bridge' : ''}`);
    }
  }
  if (r.coverage.missing.length) lines.push(`Missing: ${r.coverage.missing.slice(0, 8).map((x) => `${x.capability}=${x.reasonCode}`).join(', ')}`);
  lines.push(...r.warnings.slice(0, 4));
  lines.push('Rates change every block. Not advice.');
  return lines.join('\n');
}
