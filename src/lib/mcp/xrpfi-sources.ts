/**
 * src/lib/mcp/xrpfi-sources.ts
 * -----------------------------
 * N2 — XRPFi yield aggregator corpus. Mirrors the exact pattern of
 * flare-sources.ts / xrpl-sources.ts: source-labeled, in-memory, deterministic,
 * zero network. Answers the aigent.run headline demo query — "what's the best
 * XRP yield right now" — across the 3 real, publicly-compared venues.
 *
 * Single Responsibility: this module owns ONLY the XRPFi venue corpus + the
 * comparison/filter logic. It does not fetch live rates (see disclaimer).
 */

export interface XrpfiVenue {
  name: string;
  assets: string[];
  rateApprox: string;
  lockup: string;
  model: string;
  operator: string;
  /** true only for venues requiring a cross-chain bridge step (e.g. XRP→FXRP). */
  requiresBridge: boolean;
  regulatedStatus: string | null;
  source: string;
  date: string;
}

export const XRPFI_VENUES: readonly XrpfiVenue[] = [
  {
    name: 'Soil',
    assets: ['XRP', 'RLUSD'],
    rateApprox: 'XRP ~5% · RLUSD ~8%',
    lockup: '40-day fixed lock-up',
    model: 'Real-world assets (US treasuries, private credit, institutional loans)',
    operator: 'ORQO Group (regulated in Poland + Malta)',
    requiresBridge: false,
    regulatedStatus: 'First regulated RWA yield protocol on XRPL',
    source: 'https://store.dcentwallet.com/ja/blogs/post/xrpfi-vaults-flare-doppler-soil-compared',
    date: '2026-06-24',
  },
  {
    name: 'Flare (Monarq MXRPY)',
    assets: ['XRP (bridged as FXRP)'],
    rateApprox: '~3-4% (target, actively managed)',
    lockup: 'Periodic (a few days)',
    model: 'Active trading: options strategies + basis/funding-rate arbitrage + on-chain strategies',
    operator: 'Monarq Asset Management + Upshift vault infrastructure',
    requiresBridge: true,
    regulatedStatus: null,
    source: 'https://store.dcentwallet.com/ja/blogs/post/xrpfi-vaults-flare-doppler-soil-compared',
    date: '2026-06-24',
  },
  {
    name: 'Doppler',
    assets: ['XRP', 'RLUSD'],
    rateApprox: '~2.5%',
    lockup: 'Periodic (per operator policy)',
    model: 'Diversified institutional: CeDeFi + DeFi + RWA',
    operator: 'Custody via Fireblocks, BitGo, Copper',
    requiresBridge: false,
    regulatedStatus: 'Institutional custody disclosed',
    source: 'https://store.dcentwallet.com/ja/blogs/post/xrpfi-vaults-flare-doppler-soil-compared',
    date: '2026-06-24',
  },
] as const;

export interface YieldCompareCriteria {
  maxLockupDays?: number;
  requireNoBridge?: boolean;
}

export interface YieldCompareResult {
  venues: XrpfiVenue[];
  recommendation: string;
  disclaimer: string;
}

const DISCLAIMER =
  'Rates are approximate, sourced 2026-06-24, and change with market conditions. This is not investment advice — always verify live rates in-app before depositing.';

/** Rough day-count for a lock-up description; unmatched patterns pass every filter. */
function lockupDays(lockup: string): number | null {
  const m = lockup.match(/(\d+)-day/);
  return m ? Number(m[1]) : null;
}

export function compareYield(criteria?: YieldCompareCriteria): YieldCompareResult {
  let venues = [...XRPFI_VENUES];
  if (criteria?.requireNoBridge) venues = venues.filter((v) => !v.requiresBridge);
  if (criteria?.maxLockupDays != null) {
    venues = venues.filter((v) => {
      const days = lockupDays(v.lockup);
      return days == null || days <= criteria.maxLockupDays!;
    });
  }
  const recommendation = venues.length
    ? `${venues[0].name} shows the highest headline rate (${venues[0].rateApprox}) but check lock-up (${venues[0].lockup}) against your liquidity needs before depositing.`
    : 'No venues match the given criteria.';
  return { venues, recommendation, disclaimer: DISCLAIMER };
}
