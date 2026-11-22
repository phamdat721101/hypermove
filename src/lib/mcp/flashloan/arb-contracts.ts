import { z } from 'zod';
import { uint, digest, hash, v4KeySchema, LENDER_PROVIDERS } from './contracts';
import { address, bytes32, evmNetwork } from './networks';
import { assetIdSchema, familySchema, coverageV8Schema, usdSchema, blockV8Schema } from './v8-contracts';
import { canonicalityProofSchema, poolSchema, type Pool } from './math';
import type { DiscoveryRegistry } from './discovery-registry';

/**
 * Arb platform wire contracts S1–S6 (research file 02, amended by file 11 §F #19).
 * Chain values (addresses, tx/block hashes, V4 pool ids) are 0x-prefixed lowercase; every
 * value produced by `hash()` (cycle_id, cache_key, registry_version) is the unprefixed `digest`.
 */
export const ARB_CODE_VERSION = 'flashloan-arb/1';
const count = z.number().int().nonnegative();
const signedInt = z.string().regex(/^-?(0|[1-9][0-9]{0,77})$/);
const signedUsd = z.string().max(128).regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const poolRefSchema = z.union([address, bytes32]); // pool address, or V4 poolId
const tickIndex = z.number().int().min(-887272).max(887272);
const feePips = z.number().int().min(0).max(999999);
export const quoteCapabilitySchema = z.enum(['exact', 'estimate', 'none']); // math.ts QuoteCapability (M3 matrix)

/** S1: the M3 CREATE2 derivation proof (chain_id, adapter_version, deployer, init_code_hash, salt args), reused as-is. */
export const arbCanonicalityProofSchema = canonicalityProofSchema;

export const coverageArbSchema = coverageV8Schema.extend({
  archive: z.enum(['available', 'missing', 'not_required']),
  nodes_visited: count, max_nodes_visited: count, pools_hydrated: count,
  unauthenticated_emitters: count, unsupported_emitters: count, unpriced: count,
}).strict();

// ---- S2 Universe pool: state is a discriminated union compatible with math.ts poolSchema ----
const tickSchema = z.object({ tick: tickIndex, liquidity_net: signedInt }).strict();
const clmmFields = { sqrt_price_x96: uint, tick: tickIndex, liquidity: uint, tick_spacing: z.number().int().positive().max(32767), word_min: z.number().int(), word_max: z.number().int(), ticks: z.array(tickSchema).max(10000) };
const wordBounds = (s: { word_min: number; word_max: number }) => s.word_min <= s.word_max;
export const arbPoolStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clmm'), ...clmmFields }).strict().refine(wordBounds, 'word_min must not exceed word_max.'),
  z.object({ kind: z.literal('cpmm'), reserve0: uint, reserve1: uint, stable: z.boolean() }).strict(),
  z.object({ kind: z.literal('v4'), ...clmmFields, manager: address, pool_id: bytes32, key: v4KeySchema, protocol_fee: z.number().int().min(0).max(16777215) }).strict().refine(wordBounds, 'word_min must not exceed word_max.'),
]);
export const universePoolSchema = z.object({
  pool_ref: poolRefSchema, chain_id: z.number().int().positive(), venue_id: z.string().min(1).max(128), family: familySchema, status: z.enum(['reviewed', 'research']),
  tokens: z.tuple([assetIdSchema, assetIdSchema]), decimals: z.tuple([z.number().int().min(0).max(36), z.number().int().min(0).max(36)]),
  fee_pips: feePips, fee_mode: z.enum(['static', 'dynamic', 'hooked']), code_hash: bytes32, adapter_version: z.string().min(1).max(128),
  quote_capability: quoteCapabilitySchema, sizing: z.enum(['sizable', 'discovery_only']),
  subscription: z.object({ emitter: address, pool_id: bytes32.optional() }).strict(), // V4 emits from the manager
  block: blockV8Schema, state: arbPoolStateSchema,
  depth_coverage: z.enum(['complete', 'partial', 'none']),
  depth_usd: z.object({ pm50bps: usdSchema, pm100bps: usdSchema, pm200bps: usdSchema }).strict().nullable(), // in-range tick math, never reported TVL
  canonicality: arbCanonicalityProofSchema.nullable(),
  executor_venue_ids: z.record(z.string().regex(/^0x[0-9a-f]{40}$/), z.number().int().nonnegative()),
}).strict().superRefine((p, ctx) => {
  if (p.tokens[0] === p.tokens[1]) ctx.addIssue({ code: 'custom', path: ['tokens'], message: 'Pool tokens must differ.' });
  // File 11 #4/#13: only a CREATE2-proven, reviewed, quotable pool may be sized; research pools are discovery-only.
  if (p.sizing === 'sizable' && (!p.canonicality || p.quote_capability === 'none' || p.status !== 'reviewed')) ctx.addIssue({ code: 'custom', path: ['sizing'], message: 'Sizable pools need a canonicality proof, a quote model and reviewed status.' });
  if (p.canonicality && p.canonicality.chain_id !== p.chain_id) ctx.addIssue({ code: 'custom', path: ['canonicality', 'chain_id'], message: 'Canonicality proof is bound to another chain.' });
  if (p.state.kind === 'v4' && (p.pool_ref !== p.state.pool_id || p.subscription.emitter !== p.state.manager || p.subscription.pool_id !== p.state.pool_id)) ctx.addIssue({ code: 'custom', path: ['subscription'], message: 'V4 pools are referenced and subscribed by (manager, pool_id).' });
  if (p.depth_coverage === 'none' && p.depth_usd !== null) ctx.addIssue({ code: 'custom', path: ['depth_usd'], message: 'Depth without hydration coverage is fabricated.' });
});
export type UniversePool = z.infer<typeof universePoolSchema>;

const assetAddress = (asset: string) => asset.endsWith('/slip44:60') ? '0x' + '0'.repeat(40) : asset.slice(asset.indexOf(':0x') + 1);
/** Converts a universe pool to the solver's `Pool` (math.ts), validated by `poolSchema`. */
export function universePoolToPool(p: UniversePool): Pool {
  const base = { address: p.pool_ref, token0: assetAddress(p.tokens[0]), token1: assetAddress(p.tokens[1]), decimals0: p.decimals[0], decimals1: p.decimals[1], fee_pips: p.fee_pips, code_hash: p.code_hash, adapter_version: p.adapter_version, ...(p.quote_capability === 'estimate' ? { quote_capability: 'estimate' as const } : {}), ...(p.canonicality ? { canonicality: p.canonicality } : {}) };
  const s = p.state;
  if (s.kind === 'cpmm') return poolSchema.parse({ ...base, kind: 'v2', reserve0: s.reserve0, reserve1: s.reserve1, stable: s.stable });
  const clmm = { ...base, kind: 'clmm', sqrt_price_x96: s.sqrt_price_x96, tick: s.tick, liquidity: s.liquidity, tick_spacing: s.tick_spacing, word_min: s.word_min, word_max: s.word_max, ticks: s.ticks };
  return poolSchema.parse(s.kind === 'v4' ? { ...clmm, v4: { manager: s.manager, key: s.key, protocol_fee: s.protocol_fee } } : clmm);
}

// ---- S3 Cycle: identity is the funding asset plus ordered directed hops, so both directions survive ----
const hopSchema = z.object({ pool_ref: poolRefSchema, token_in: assetIdSchema, token_out: assetIdSchema }).strict();
export type CycleHop = z.infer<typeof hopSchema>;
export function arbCycleId(fundingAsset: string, hops: CycleHop[]): string {
  return hash({ funding_asset: fundingAsset, hops: hops.map((h) => ({ pool_ref: h.pool_ref.toLowerCase(), token_in: h.token_in, token_out: h.token_out })) });
}
export const cycleSchema = z.object({
  cycle_id: digest, funding_asset: assetIdSchema, hops: z.array(hopSchema).min(2).max(4),
  fee_floor_bps_approx: z.number().finite().nonnegative(),
  lenders: z.array(z.object({ lender_id: z.string().min(1).max(128), provider: z.enum(LENDER_PROVIDERS), address, fee_bps: z.number().finite().nonnegative(), capacity_raw: uint }).strict()).max(4), // cheapest first
  realized: z.object({ window_blocks: count, arbs: count, gross_usd: usdSchema, net_usd: signedUsd, bots: count }).strict().nullable(), // verified tier only (file 11 #14)
  rank: count,
}).strict().superRefine((c, ctx) => {
  const h = c.hops;
  if (h[0].token_in !== c.funding_asset || h[h.length - 1].token_out !== c.funding_asset) ctx.addIssue({ code: 'custom', path: ['hops'], message: 'Cycle must start and end in the funding asset.' });
  h.forEach((hop, i) => { if (hop.token_in === hop.token_out || (i > 0 && h[i - 1].token_out !== hop.token_in)) ctx.addIssue({ code: 'custom', path: ['hops', i], message: 'Hops must chain token_out to the next token_in.' }); });
  if (arbCycleId(c.funding_asset, h) !== c.cycle_id) ctx.addIssue({ code: 'custom', path: ['cycle_id'], message: 'cycle_id does not match hash(funding_asset, ordered directed hops).' });
});

// ---- S4 Closed-loop arb record ----
export const arbRecordSchema = z.object({
  tier: z.enum(['swap_surplus_candidate', 'verified_realized']),
  tx: bytes32, block: uint, tx_index: count, to: address, from: address,
  hops: z.array(z.object({ pool_ref: poolRefSchema, venue_id: z.string().max(128).nullable(), delta: z.tuple([signedInt, signedInt]) }).strict()).min(1).max(16), // signed raw, swapper view
  net_by_asset: z.record(assetIdSchema, signedInt),
  gross_usd: usdSchema, gas_usd: usdSchema.nullable(), net_usd: signedUsd.nullable(),
  priority_gwei: usdSchema.nullable(), // effectiveGasPrice − block baseFee (non-negative decimal)
  express_lane: z.boolean().nullable(), // reserved: null until Timeboost status is confirmed
  trigger: z.object({ tx: bytes32, tx_index: count, shared_pools: z.array(poolRefSchema).max(16) }).strict().nullable(),
  cycle_id: digest.nullable(),
  price_sources: z.array(z.string().max(256)).max(8),
}).strict().superRefine((r, ctx) => {
  const nets = Object.entries(r.net_by_asset);
  for (const [asset, net] of nets) if (BigInt(net) < 0n) ctx.addIssue({ code: 'custom', path: ['net_by_asset', asset], message: 'A closed-loop arb never ends net-negative in any asset.' });
  if (!nets.some(([, net]) => BigInt(net) > 0n)) ctx.addIssue({ code: 'custom', path: ['net_by_asset'], message: 'A closed-loop arb gains at least one asset.' });
  if (r.trigger && r.trigger.tx_index >= r.tx_index) ctx.addIssue({ code: 'custom', path: ['trigger', 'tx_index'], message: 'The trigger precedes the arb in the block.' });
});
export type ArbRecord = z.infer<typeof arbRecordSchema>;

// ---- S5 Cycle quote (file 11 #9, #11): missing gas or a non-exact model makes the quote INCONCLUSIVE ----
const nullableWei = uint.nullable();
export const cycleQuoteSchema = z.object({
  cycle_id: digest, block: blockV8Schema, mode: z.enum(['historical', 'live']), pre_swaps_applied: count,
  principal_raw: uint, expected_out_raw: nullableWei,
  lender: z.object({ lender_id: z.string().min(1).max(128), provider: z.enum(LENDER_PROVIDERS), fee_raw: uint }).strict(),
  gross_raw: signedInt.nullable(),
  gas: z.object({ gas_units: nullableWei, base_fee_wei: nullableWei, priority_bid_wei: nullableWei, gas_price_wei: nullableWei, cost_in_borrow_raw: nullableWei, eth_usd: usdSchema.nullable() }).strict(),
  net_raw: signedInt.nullable(), net_usd: signedUsd.nullable(),
  margin_raw: uint,
  min_profit_raw: nullableWei, // executor threshold = gas cost in borrow units + margin
  outcome: z.enum(['PROFITABLE', 'UNPROFITABLE', 'INCONCLUSIVE']), reason: z.string().min(1).max(128).nullable(),
  fidelity: z.object({ quote_capability: quoteCapabilitySchema, tick_words_loaded: count, crossed_unloaded_tick: z.boolean(), hooks: z.boolean() }).strict(),
  route_payload: z.object({ executor: address, calldata_unsigned: z.string().regex(/^0x(?:[0-9a-f]{2})*$/) }).strict().nullable(),
}).strict().superRefine((q, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if ((q.outcome === 'INCONCLUSIVE') !== (q.reason !== null)) issue('reason', 'Exactly the INCONCLUSIVE outcome carries a reason.');
  if (q.outcome === 'INCONCLUSIVE') return;
  const g = q.gas;
  if (Object.values(g).some((v) => v === null) || q.expected_out_raw === null || q.gross_raw === null || q.net_raw === null || q.min_profit_raw === null) return issue('gas', 'A decided quote needs every gas component and the full net.');
  if (q.fidelity.quote_capability !== 'exact' || q.fidelity.crossed_unloaded_tick) issue('fidelity', 'Only an exact quote over loaded ticks can be decided.');
  if (BigInt(q.min_profit_raw) !== BigInt(g.cost_in_borrow_raw!) + BigInt(q.margin_raw)) issue('min_profit_raw', 'min_profit_raw must equal gas cost plus margin.');
  if (BigInt(g.cost_in_borrow_raw!) + BigInt(q.margin_raw) === 0n) issue('outcome', 'Zero gas and zero margin is INCONCLUSIVE (ZERO_COST_POLICY).');
  if ((q.outcome === 'PROFITABLE') !== (BigInt(q.net_raw) >= BigInt(q.margin_raw))) issue('outcome', 'PROFITABLE iff net_raw >= margin_raw.');
});
export type CycleQuote = z.infer<typeof cycleQuoteSchema>;

// ---- S6 Replay event ----
export const replayEventSchema = z.object({
  trigger_tx: bytes32, block: uint, tx_index: count, trigger_pool: poolRefSchema, trigger_usd: usdSchema.nullable(),
  best_cycle_id: digest.nullable(), our_net_usd: signedUsd.nullable(), // if landed at tx_index + 1
  taken_by: z.object({ tx: bytes32, to: address, tx_index: count, match: z.enum(['same_directed_cycle', 'same_pools_opposite_direction']), net_usd: signedUsd.nullable() }).strict().nullable(),
  latency_ms_to_winner: count.nullable(),
  fidelity: z.enum(['EXACT_EVENT_STATE', 'TICK_APPROX', 'UNSUPPORTED_VENUE']), reason: z.string().min(1).max(128).nullable(),
}).strict().superRefine((e, ctx) => {
  if (e.taken_by && e.taken_by.tx_index <= e.tx_index) ctx.addIssue({ code: 'custom', path: ['taken_by', 'tx_index'], message: 'The winner lands after the trigger.' });
});

// ---- Envelope payloads and shared-artifact documents ----
const head = { network: evmNetwork, chain_id: z.number().int().positive() };
const windowSchema = z.object({ from_block: uint, to_block: uint, from_hash: bytes32, to_hash: bytes32 }).strict().refine((w) => BigInt(w.from_block) <= BigInt(w.to_block), 'Empty block window.');
/** Universe coverage (PRD-B §6): the share of the latest verified GT gross whose hop pools are all in the universe; null without a GT artifact. */
export const coverageUniverseSchema = coverageArbSchema.extend({ realized_value_share: z.number().min(0).max(1).nullable(), ground_truth_window: z.object({ from_block: uint, to_block: uint }).strict().nullable() }).strict();
export const arbUniversePayloadSchema = z.object({ schema_version: z.literal('flashloan.arb.universe.v1'), ...head, block: blockV8Schema, registry_version: digest, cache_key: digest, outcome: z.enum(['SUCCESS', 'EMPTY', 'PARTIAL']), pools: z.array(universePoolSchema).max(400), cycles: z.array(cycleSchema).max(4000), coverage: coverageUniverseSchema, warnings: z.array(z.string().max(512)).max(64) }).strict();
export const arbCycleQuotePayloadSchema = z.object({ schema_version: z.literal('flashloan.arb.cycle_quote.v1'), ...head, quote: cycleQuoteSchema }).strict();
export const arbGroundTruthSchema = z.object({ schema_version: z.literal('flashloan.arb.ground_truth.v1'), ...head, window: windowSchema, records: z.array(arbRecordSchema).max(20000), coverage: coverageArbSchema, warnings: z.array(z.string().max(512)).max(64) }).strict();
// ---- PRD-C ground truth (file 11 #14, #17): two tiers plus the complete ordered event dataset M8/M9 replay from ----
export const ARB_EVENT_KINDS = ['swap_v3', 'swap_pancake', 'swap_v2', 'swap_v4', 'sync', 'mint_v3', 'burn_v3', 'mint_v2', 'burn_v2', 'modify_liquidity_v4'] as const;
export const ARB_DATASET_PAGE_EVENTS = 10_000;
/** One authenticated pool event; `fields` are the decoded raw event arguments (decimal integers, lowercase hex for addresses/bytes32). */
export const arbDatasetEventSchema = z.object({ block: uint, tx_index: count, log_index: count, tx: bytes32, block_hash: bytes32, emitter: address, pool_ref: poolRefSchema, venue_id: z.string().max(128), kind: z.enum(ARB_EVENT_KINDS), fields: z.record(z.string().max(32), z.string().max(80)) }).strict();
export type ArbDatasetEvent = z.infer<typeof arbDatasetEventSchema>;
export const arbEventDatasetPageSchema = z.object({ schema_version: z.literal('flashloan.arb.event_dataset.v1'), ...head, window: windowSchema, ordering: z.literal('block,tx_index,log_index'), page: count, pages: z.number().int().positive(), events: z.array(arbDatasetEventSchema).max(ARB_DATASET_PAGE_EVENTS) }).strict();
const datasetRefSchema = z.object({ complete: z.boolean(), total_events: count, by_kind: z.record(z.string(), count), pages: z.array(z.object({ artifact_id: digest, cache_key: digest, content_hash: digest, events: count }).strict()).max(256) }).strict();
const bucketSchema = z.object({ '<0.05': count, '0.05-0.5': count, '0.5-5': count, '>5': count }).strict();
export const arbGroundTruthDocumentSchema = arbGroundTruthSchema.extend({
  cache_key: digest, registry_version: digest, outcome: z.enum(['SUCCESS', 'EMPTY', 'INCONCLUSIVE']), reason: z.string().min(1).max(160).nullable(),
  inputs: z.object({ include_v4: z.boolean(), min_gross_usd: z.number().finite().nonnegative() }).strict(),
  totals: z.object({ events: count, swaps: count, multi_pool_txs: count, candidates: count, candidates_priced: count, verified: count, candidate_gross_usd: usdSchema, verified_gross_usd: usdSchema, gas_usd: usdSchema, verified_net_usd: signedUsd, receipts_missing: count, receipts_rejected: count }).strict(),
  by_bot: z.array(z.object({ to: address, arbs: count, verified: count, gross_usd: usdSchema, net_usd: signedUsd.nullable() }).strict()).max(50),
  by_bucket: bucketSchema,
  tx_index: z.object({ p50: z.number().nonnegative().nullable(), share_le_3: z.number().min(0).max(1).nullable() }).strict(),
  prices: z.array(z.object({ asset: assetIdSchema, usd: usdSchema, source: z.string().max(256) }).strict()).max(32),
  unverified_reasons: z.record(z.string(), count),
  dataset: datasetRefSchema,
}).strict().superRefine((d, ctx) => {
  if ((d.outcome === 'INCONCLUSIVE') !== (d.reason !== null)) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Exactly the INCONCLUSIVE outcome carries a reason.' });
  if (d.outcome === 'EMPTY' && d.records.length) ctx.addIssue({ code: 'custom', path: ['records'], message: 'EMPTY carries no records.' });
});
export type ArbGroundTruthDocument = z.infer<typeof arbGroundTruthDocumentSchema>;
/** Job result: the full document is a shared artifact, so any caller reads the same bytes. */
export const arbGroundTruthRefSchema = z.object({ schema_version: z.literal('flashloan.arb.ground_truth_ref.v1'), network: evmNetwork, artifact_id: digest, cache_key: digest, content_hash: digest, outcome: z.enum(['SUCCESS', 'EMPTY', 'INCONCLUSIVE']), reason: z.string().max(160).nullable(), reused: z.boolean() }).strict();
export const backrunReplaySchema = z.object({ schema_version: z.literal('flashloan.arb.backrun_replay.v1'), ...head, window: windowSchema, events: z.array(replayEventSchema).max(20000), independent_upper_bound_usd: signedUsd, sequential_strategy_pnl_usd: signedUsd.nullable(), verdict: z.enum(['GO', 'NO_GO', 'INCONCLUSIVE']), coverage: coverageArbSchema, warnings: z.array(z.string().max(512)).max(64) }).strict();
/** Envelope kind → payload schema (public-contracts.ts ARB_PROOF_KINDS). */
export const arbEnvelopePayloads = { evm_universe: arbUniversePayloadSchema, evm_cycle_quote: arbCycleQuotePayloadSchema } as const;
/** Shared artifact kind → document schema (storage.ts retention). */
export const arbArtifactDocuments = { arb_universe: arbUniversePayloadSchema, arb_ground_truth: arbGroundTruthDocumentSchema, arb_event_dataset: arbEventDatasetPageSchema, backrun_replay: backrunReplaySchema } as const;

// ---- Cache identity (file 11 #21): registry_version excludes seeds and weights, so the full config is hashed ----
const normalizeInput = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeInput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'idempotency_key').map(([k, v]) => [k, normalizeInput(v)]));
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? value.toLowerCase() : value;
};
export function arbCacheKey(args: { op: string; network: z.infer<typeof evmNetwork>; registry: DiscoveryRegistry; deployments_version: string; inputs: Record<string, unknown> }): string {
  return hash({ op: args.op, network: args.network, registry: args.registry.config, deployments_version: digest.parse(args.deployments_version), code_version: ARB_CODE_VERSION, inputs: normalizeInput(args.inputs) });
}
/** Order-independent version of a reviewed deployments template list. */
export const deploymentsVersion = (deployments: unknown[]) => hash(deployments.map((d) => hash(d)).sort());

/** JSON-schema export (same pattern as v8DocumentSchemas). */
export function arbDocumentSchemas() {
  const json = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
  return { universe: json(arbUniversePayloadSchema), cycle_quote: json(arbCycleQuotePayloadSchema), ground_truth: json(arbGroundTruthDocumentSchema), backrun_replay: json(backrunReplaySchema) };
}
