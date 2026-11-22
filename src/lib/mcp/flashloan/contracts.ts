import { createHash } from 'node:crypto';
import { z } from 'zod';
import { suiOperations } from './sui-contracts';
import { evmNetwork, discoveryNetwork, address, coinType, bytes32, CHAINS } from './networks';
export { evmNetwork, address, CHAINS } from './networks';

export const VERSION = 'flashloan-research/2';
export const network = z.enum(['ethereum', 'arbitrum', 'base', 'robinhood', 'sui', 'xrpl']);
export const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((value) => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n, 'Amount exceeds uint256.');
export const hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const xrplAccount = z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
export const xrplAsset = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('xrp') }).strict(),
  z.object({ kind: z.literal('issued'), currency: z.string().regex(/^(?!XRP$)(?:[\x21-\x7E]{3}|[A-Fa-f0-9]{40})$/), issuer: xrplAccount }).strict(),
]);
export const v4KeySchema = z.object({ currency0: address, currency1: address, fee: z.number().int().min(0).max(999999), tickSpacing: z.number().int().positive().max(32767), hooks: address }).strict();
export const poolRef = z.object({ address: z.union([address, bytes32]), pool_key: v4KeySchema.optional(), manager: address.optional(), adapter: z.enum(['UNISWAP_V2', 'UNISWAP_V3', 'UNISWAP_V4', 'ALGEBRA', 'AERODROME_VOLATILE', 'AERODROME_STABLE', 'AERODROME_CLMM']), word_range: z.number().int().min(0).max(16).default(3) }).strict();
export const riskPolicy = z.object({
  max_principal: uint, min_profit: uint.default('0'), max_price_impact_bps: z.number().int().min(1).max(5000).default(100),
  max_routes: z.number().int().min(1).max(5).default(5), max_evaluations: z.number().int().min(1).max(10000).default(1000),
  network_cost: uint, min_weight_bps: z.number().int().min(0).max(10000).default(0),
  min_deployment_bps: z.number().int().min(0).max(10000).default(0),
}).strict();
const start = { idempotency_key: z.string().min(1).max(128) };
export const discoveryRequestSchema = z.object({ ...start, network: discoveryNetwork, tokens: z.array(z.string().min(1).max(1024)).min(1).max(300), native_cursors: z.partialRecord(z.enum(['CETUS_CLMM', 'DEEPBOOK_V3']), z.string().max(4096)).default({}), native_page_size: z.number().int().min(1).max(100).default(50), native_max_pages: z.number().int().min(1).max(5).default(2), min_liquidity_usd: z.number().finite().min(0).default(15000), exclude_tokens: z.array(z.string().min(1).max(1024)).max(300).default([]) }).strict();
export const validateDiscoveryTokens = (input: { network: string; tokens: string[]; exclude_tokens: string[] }, ctx: z.RefinementCtx) => {
    const schema = input.network === 'sui' ? coinType : address;
    for (const key of ['tokens', 'exclude_tokens'] as const) input[key].forEach((token, i) => { if (!schema.safeParse(token).success) ctx.addIssue({ code: 'custom', path: [key, i], message: 'Invalid token identifier for network.' }); });
  };
/** Flash lenders in ResearchExecutor provider-id order (index = `provider` argument). MORPHO_BLUE is admitted only behind FLASHLOAN_ARB_LENDERS_V1 so the flag-off tool list stays byte-identical. */
export const LENDER_PROVIDERS = ['AAVE_V3', 'BALANCER_V2', 'UNISWAP_V3_FLASH', 'MORPHO_BLUE'] as const;
export type LenderProvider = typeof LENDER_PROVIDERS[number];
export const lendersV1Enabled = () => process.env.FLASHLOAN_ARB_LENDERS_V1 === 'true';
const ingestSchema = <P extends readonly [string, ...string[]]>(providers: P) => z.object({ ...start, network: evmNetwork, pools: z.array(poolRef).min(1).max(20), lender: z.object({ provider: z.enum(providers), address, asset: address }).strict() }).strict();
const ingestLegacy = ingestSchema(['AAVE_V3', 'BALANCER_V2', 'UNISWAP_V3_FLASH'] as const);
const ingestLendersV1 = ingestSchema(LENDER_PROVIDERS);
/** PRD-C ground truth (file 11 §C): authenticated shared job, admitted only behind FLASHLOAN_ARB_GT_V1 so the flag-off tool list stays byte-identical. */
export const GROUND_TRUTH_OPERATION = 'flashloan_arb_ground_truth_v1';
export const arbGtEnabled = () => process.env.FLASHLOAN_ARB_GT_V1 === 'true';
/** PRD-B universe (file 11 §B): a public cached tool behind FLASHLOAN_ARB_UNIVERSE_V1; its build runs only as a shared worker job, never as a private tool. */
export const UNIVERSE_OPERATION = 'flashloan_get_arb_universe_v1';
export const arbUniverseEnabled = () => process.env.FLASHLOAN_ARB_UNIVERSE_V1 === 'true';
export const universeInputSchema = z.object({ network: z.enum(['arbitrum', 'base', 'ethereum']), seed_tokens: z.array(address).max(30).default([]), min_depth_usd: z.number().finite().min(0).max(1e12).default(25_000),
  max_hops: z.number().int().min(2).max(4).default(3), max_cycles: z.number().int().min(1).max(512).default(256), max_nodes_visited: z.number().int().min(1).max(200_000).default(50_000),
  include_research: z.boolean().default(false), include_v4: z.boolean().default(true) }).strict();
/** A pinned universe: its build input (defaults when omitted) plus the content hash the caller saw. */
const universeSelector = universeInputSchema.omit({ network: true }).strict();
/** PRD-D cycle quote (file 11 §D): public, synchronous and data only (no calldata, no executor estimateGas) behind FLASHLOAN_QUOTE_CYCLE_V1. */
export const QUOTE_CYCLE_OPERATION = 'flashloan_quote_cycle_v1';
export const arbQuoteCycleEnabled = () => process.env.FLASHLOAN_QUOTE_CYCLE_V1 === 'true';
export const cyclePolicySchema = z.object({ max_principal: uint, max_price_impact_bps: z.number().int().min(1).max(5000).default(100), margin_bps: z.number().min(0).max(1000).default(10), margin_raw: uint.default('0'), max_evaluations: z.number().int().min(1).max(500).default(300) }).strict();
export const quoteCycleInputSchema = z.object({
  network: z.enum(['arbitrum', 'base', 'ethereum']),
  cycle: z.union([
    z.object({ cycle_id: digest, universe_content_hash: digest, universe_input: universeSelector.optional() }).strict(),
    z.object({ funding_asset: address, hops: z.array(z.object({ pool: poolRef.extend({ word_range: z.number().int().min(0).max(1).default(1) }).strict(), token_in: address, token_out: address }).strict()).min(2).max(4) }).strict(),
  ]),
  block: uint.optional(),
  pre_swaps: z.array(z.union([z.object({ tx_hash: bytes32 }).strict(), z.object({ pool_ref: z.union([address, bytes32]), token_in: address, amount_in_raw: uint }).strict()])).max(4).default([]),
  priority_bid_wei: uint.optional(),
  policy: cyclePolicySchema,
}).strict();
export const operationEnabled = (name: string) => name === UNIVERSE_OPERATION ? false : name !== GROUND_TRUTH_OPERATION || arbGtEnabled();
export const groundTruthInputSchema = z.object({ ...start, network: z.enum(['arbitrum', 'base', 'ethereum']), from_block: uint.optional(), to_block: uint.optional(),
  window_blocks: z.number().int().min(100).max(20_000).default(14_400), include_v4: z.boolean().default(true), min_gross_usd: z.number().finite().min(0).max(1e12).default(0) }).strict()
  .superRefine((v, ctx) => {
    if (v.from_block !== undefined && v.to_block !== undefined && (BigInt(v.to_block) < BigInt(v.from_block) || BigInt(v.to_block) - BigInt(v.from_block) >= 20_000n)) ctx.addIssue({ code: 'custom', path: ['to_block'], message: 'Window must be 1..20000 blocks.' });
  });
export const operationSchemas = {
  ...suiOperations,
  flashloan_discover_arbitrage_pools: discoveryRequestSchema.superRefine(validateDiscoveryTokens),
  get flashloan_ingest_l2_tickmap_and_reserves(): typeof ingestLendersV1 { return (lendersV1Enabled() ? ingestLendersV1 : ingestLegacy) as unknown as typeof ingestLendersV1; },
  flashloan_solve_dynamic_route_split: z.object({ ...start, snapshot_id: digest, borrow_asset: address, policy: riskPolicy }).strict(),
  flashloan_simulate_atomic_revm: z.object({ ...start, plan_id: digest, caller: address, executor_mode: z.enum(['existing', 'fixture']), executor: address }).strict(),
  xrpl_discover_arbitrage_routes: z.object({ ...start, network: z.literal('xrpl'), assets: z.array(xrplAsset).min(2).max(10), funding: z.discriminatedUnion('mode', [z.object({ mode: z.literal('account'), account: xrplAccount }).strict(), z.object({ mode: z.literal('hypothetical'), balances: z.array(z.object({ asset: xrplAsset, amount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/) }).strict()).min(1).max(10) }).strict()]) }).strict(),
  xrpl_simulate_arbitrage_route: z.object({ ...start, route_id: digest, transaction: z.record(z.string(), z.unknown()).optional() }).strict(),
  nim_memory_sync_flashloan_lesson: z.object({ ...start, operation: z.enum(['RETRIEVE', 'PROPOSE', 'VALIDATE', 'COMMIT']), query: z.string().min(3).max(8000).optional(), report_id: digest.optional(), proposal_id: z.string().min(1).max(128).optional() }).strict(),
  flashloan_arb_ground_truth_v1: groundTruthInputSchema,
  flashloan_get_arb_universe_v1: universeInputSchema.extend(start).strict(),
  flashloan_research_job: z.object({ operation: z.enum(['get', 'cancel', 'artifact', 'capabilities']), job_id: z.string().uuid().optional(), artifact_id: digest.optional(), offset: z.number().int().min(0).max(8_000_000).default(0), limit: z.number().int().min(1).max(100000).default(100000) }).strict(),
};
export type Operation = keyof typeof operationSchemas;
export const jobState = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
export const jobSchema = z.object({ id: z.string().uuid(), operation: z.string(), state: jobState, created_at: z.string(), updated_at: z.string(), result_id: digest.optional(), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional() }).strict();
export type Job = z.infer<typeof jobSchema>;
export type RiskPolicy = z.infer<typeof riskPolicy>;
export type XrplAsset = z.infer<typeof xrplAsset>;
export type PoolRef = z.infer<typeof poolRef>;
export type EvmNetwork = z.infer<typeof evmNetwork>;
export type Input<K extends Operation> = z.infer<typeof operationSchemas[K]>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export class ResearchError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); this.name = 'ResearchError'; }
}
export function errorResult(error: unknown): { code: string; message: string; retryable: boolean } {
  return error instanceof ResearchError ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: 'RESEARCH_FAILED', message: 'Research failed; inspect the worker trace using the job ID.', retryable: false };
}
/** Secret-free delivery boundary markers; never log raw RPC URLs or payloads. */
export function boundaryEvent(edge: 'EDGE-01' | 'EDGE-02' | 'EDGE-03' | 'EDGE-04' | 'EDGE-05', code: string): void {
  console.warn(JSON.stringify({ event: 'flashloan.' + edge, code }));
}
