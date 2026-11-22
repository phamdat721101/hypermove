import { z } from 'zod';
import { ResearchError } from './contracts';
import type { ProofEnvelope } from './public-contracts';
import { XRPL_RLUSD } from './rlusd-devtools';
import { assetKey, decimal, decimalText, quoteXrpl, type XrplEdge, type XrplSnapshot } from './xrpl';

const dropsPerXrp = 1_000_000n;
const basisPoints = 10_000;
const rlusdKey = assetKey(XRPL_RLUSD);

export const xrplHolderReportInput = z.object({
  xrp_amount_drops: z.string().regex(/^(?:[1-9]\d{0,16}|100000000000000000)$/),
  scenario: z.object({
    xrp_price_change_bps: z.number().int().min(-basisPoints).max(100_000),
    holding_days: z.number().int().min(1).max(365),
    assumed_xrp_apy_bps: z.number().int().min(0).max(100_000).default(0),
    stablecoin_weight_bps: z.number().int().min(0).max(basisPoints).default(2500),
  }).strict(),
}).strict();

function xrpExitQuote(edge: XrplEdge | undefined, amountXrp: string) {
  if (!edge) return { status: 'UNAVAILABLE', reason: 'NO_MARKET_EDGE' } as const;
  if (edge.restrictions.length) return { status: 'UNAVAILABLE', reason: 'MARKET_RESTRICTED', restrictions: edge.restrictions } as const;
  try {
    const proceeds = quoteXrpl(edge, amountXrp);
    if (proceeds === '0') return { status: 'UNAVAILABLE', reason: 'NO_LIQUIDITY' } as const;
    return { status: 'ESTIMATE_ONLY', rlusd_out: proceeds } as const;
  } catch (error) {
    if (error instanceof ResearchError && error.code === 'INSUFFICIENT_BOOK_DEPTH') {
      return { status: 'UNAVAILABLE', reason: error.code } as const;
    }
    throw error;
  }
}

function modelScenario(input: z.infer<typeof xrplHolderReportInput>['scenario'], amountDrops: bigint) {
  const priceRatio = 1 + input.xrp_price_change_bps / basisPoints;
  const growthLog = Math.log1p(input.assumed_xrp_apy_bps / basisPoints) * (input.holding_days / 365);
  const growth = Math.exp(growthLog);
  const stableWeight = input.stablecoin_weight_bps / basisPoints;
  const ammRatio = Math.sqrt(priceRatio);
  const balancedRatio = (1 + priceRatio) / 2;
  const growthFraction = decimal(growth.toFixed(12));
  const modeledEndDrops = amountDrops * growthFraction.n / growthFraction.d;
  return {
    inputs: input,
    xrp_yield_unit_growth_fraction: Math.expm1(growthLog),
    xrp_yield_end_amount_drops: modeledEndDrops.toString(),
    usd_return_fractions: {
      hold_xrp: priceRatio - 1,
      xrp_yield: priceRatio * growth - 1,
      xrp_rlusd_50_50_amm_before_fees: ammRatio - 1,
      xrp_rlusd_50_50_hold: balancedRatio - 1,
      xrp_rlusd_amm_vs_balanced_hold_delta: ammRatio - balancedRatio,
      xrp_rlusd_stablecoin_buffer: (1 - stableWeight) * (priceRatio - 1),
    },
  };
}

export function xrplHolderReport(proof: ProofEnvelope, snapshot: XrplSnapshot, input: z.infer<typeof xrplHolderReportInput>) {
  if (snapshot.network !== 'xrpl' || snapshot.estimate_only !== true || !Number.isSafeInteger(snapshot.ledger_index)
    || snapshot.ledger_index < 1 || !/^[A-Fa-f0-9]{64}$/.test(snapshot.ledger_hash)) {
    throw new ResearchError('INVALID_SNAPSHOT', 'A validated XRP Ledger snapshot is required.');
  }
  const exits = snapshot.edges.filter((edge) => edge.from === 'XRP' && edge.to === rlusdKey);
  const amm = exits.find((edge) => edge.kind === 'amm');
  const book = exits.find((edge) => edge.kind === 'book');
  if (!amm && !book) throw new ResearchError('UNSUPPORTED_MARKET', 'Snapshot does not cover XRP to RLUSD from the supported issuer.');

  const amountDrops = BigInt(input.xrp_amount_drops);
  const amountXrp = decimalText({ n: amountDrops, d: dropsPerXrp }, 18);
  return {
    schema_version: 'xrpl.holder_report.v1',
    status: 'ESTIMATE_ONLY',
    network: 'xrpl',
    sale: {
      xrp_amount_drops: input.xrp_amount_drops,
      xrp_amount: amountXrp,
      counter_asset: XRPL_RLUSD,
      amm: { ...xrpExitQuote(amm, amountXrp), trading_fee_units_per_100000: amm?.fee_units ?? null },
      book: xrpExitQuote(book, amountXrp),
      network_fee_xrp: null,
      issuer_transfer_cost_rlusd: null,
      account_eligibility: 'NOT_CHECKED',
    },
    source: {
      ledger_hash: snapshot.ledger_hash,
      ledger_index: snapshot.ledger_index,
      funding_mode: snapshot.funding.mode,
      issued_at: proof.issued_at,
      expires_at: proof.expires_at,
      content_hash: proof.content_hash,
    },
    scenario: modelScenario(input.scenario, amountDrops),
    realized_lp_fee_income: null,
    warnings: [
      ...snapshot.warnings,
      'Exit estimates use each venue in isolation. The AMM estimate includes its posted base swap fee; network and issuer costs are unknown.',
      'Scenario returns are modeled before costs with RLUSD at USD parity. The LP model assumes a fee-free constant-product pool with a matched 50/50 starting allocation.',
      'XRP yield is a user assumption, compounded over the specified horizon. The modeled end amount is rounded down to whole drops.',
    ],
  };
}
