import { z } from 'zod';
import { rlusdDevtoolsSchema } from './rlusd-devtools';
import { xrplHolderReportInput } from './xrpl-holder-report';
import { moverInputSchema } from './movers';
import { suiOperations, suiPolicy } from './sui-contracts';
import { operationSchemas, discoveryRequestSchema, validateDiscoveryTokens, address, digest, ResearchError, riskPolicy, uint, evmNetwork, universeInputSchema, arbUniverseEnabled, UNIVERSE_OPERATION, quoteCycleInputSchema, arbQuoteCycleEnabled, QUOTE_CYCLE_OPERATION } from './contracts';
import { candidateRequestV2Schema, resolutionRequestSchema } from './integration-contracts';
import { v8Enabled, discoveryV3InputSchema, moversV2InputSchema, watchlistInputSchema, registryInputSchema } from './v8-contracts';

export const PUBLIC_VERSION = 'flashloan.public.v3';
function configured(name: string, ceiling: number, minimum = 1) {
  const raw = process.env['FLASHLOAN_PUBLIC_' + name];
  if (process.env.FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS !== 'true' || raw === undefined) return ceiling;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > ceiling) throw new ResearchError('PUBLIC_UNCONFIGURED', 'Public limit ' + name + ' is outside its tested bounds.');
  return value;
}
export const PUBLIC_LIMITS = Object.freeze({ body_bytes: 2 * 1024 * 1024, envelope_bytes: 1024 * 1024, tokens: configured('MAX_TOKENS', 30), pools: configured('MAX_POOLS', 4), word_range: 1, ticks: configured('MAX_TICKS', 2000), xrpl_assets: configured('MAX_XRPL_ASSETS', 4, 2), routes: configured('MAX_ROUTES', 3), evaluations: configured('MAX_EVALUATIONS', 500), cpu_ms: 5000, operation_ms: configured('OPERATION_MS', 30000, 1000), simulation_ms: configured('SIMULATION_MS', 60000, 1000), public_concurrency: 1, total_concurrency: 2, computations_per_minute: configured('COMPUTATIONS_PER_MINUTE', 6), transport_per_minute: configured('TRANSPORT_PER_MINUTE', 60), proof_ttl_ms: configured('PROOF_TTL_MS', 600000, 1000) });
export const proofEnvelopeSchema = z.object({ version: z.literal(2), kind: z.enum(['evm_snapshot', 'evm_plan', 'xrpl_routes', 'sui_snapshot', 'sui_plan']), issued_at: z.string().datetime(), expires_at: z.string().datetime(), registry_version: digest, content_hash: digest, payload: z.record(z.string(), z.unknown()), proof: z.object({ algorithm: z.literal('HS256'), key_id: z.literal('v2'), signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict() }).strict();
export type ProofEnvelope = z.infer<typeof proofEnvelopeSchema>;
/** Arb envelope kinds. Legacy tool inputs keep `proofEnvelopeSchema` (byte-identical tool lists); `verify` accepts the wider kind set. */
export const ARB_PROOF_KINDS = ['evm_universe', 'evm_cycle_quote'] as const;
export const proofKindSchema = z.enum([...proofEnvelopeSchema.shape.kind.options, ...ARB_PROOF_KINDS]);
export const anyProofEnvelopeSchema = proofEnvelopeSchema.extend({ kind: proofKindSchema }).strict();
export type ProofKind = z.infer<typeof proofKindSchema>;
export type KindedEnvelope<K extends ProofKind> = Omit<ProofEnvelope, 'kind'> & { kind: K };
/** Per-kind TTL caps (file 11 #22): universe keeps the 600 s cap, a block-pinned cycle quote lives 30 s; never above the configured cap. */
const PROOF_TTL_MS_BY_KIND: Partial<Record<ProofKind, number>> = { evm_universe: 600_000, evm_cycle_quote: 30_000 };
export const proofTtlMs = (kind: ProofKind) => Math.min(PUBLIC_LIMITS.proof_ttl_ms, PROOF_TTL_MS_BY_KIND[kind] ?? Infinity);
const discovery = discoveryRequestSchema.omit({ idempotency_key: true });
const snapshot = operationSchemas.flashloan_ingest_l2_tickmap_and_reserves.omit({ idempotency_key: true });
const xrpl = operationSchemas.xrpl_discover_arbitrage_routes.omit({ idempotency_key: true });
const policy = riskPolicy.extend({ max_routes: z.number().int().min(1).max(PUBLIC_LIMITS.routes).default(PUBLIC_LIMITS.routes), max_evaluations: z.number().int().min(1).max(PUBLIC_LIMITS.evaluations).default(PUBLIC_LIMITS.evaluations) });
export const candidateResearchEnabled = () => process.env.FLASHLOAN_CANDIDATE_RESEARCH_V1 === 'true';
export const integrationEnabled = () => process.env.FLASHLOAN_CANDIDATE_RESEARCH_V2 === 'true';
export const resolutionEnabled = () => process.env.FLASHLOAN_POOL_RESOLUTION_V1 === 'true';
export const watchlistEnabled = () => v8Enabled('WATCHLIST_V1') && v8Enabled('INVENTORY_V3') && v8Enabled('MOVERS_V2') && v8Enabled('REGISTRY_V1');
export const publicOperationEnabled = (name: string) => name === UNIVERSE_OPERATION ? arbUniverseEnabled() : name === QUOTE_CYCLE_OPERATION ? arbQuoteCycleEnabled() : name === 'flashloan_get_watchlist_v1' ? watchlistEnabled() : name === 'flashloan_get_registry_v1' ? v8Enabled('REGISTRY_V1') : name === 'flashloan_research_candidates_v1' ? candidateResearchEnabled() : name === 'flashloan_research_candidates_v2' ? integrationEnabled() : name === 'flashloan_resolve_pool_inventory_v1' ? resolutionEnabled() : true;
const legacyDiscovery = discovery.extend({ tokens: discovery.shape.tokens.max(PUBLIC_LIMITS.tokens), exclude_tokens: discovery.shape.exclude_tokens.removeDefault().max(PUBLIC_LIMITS.tokens).default([]) }).strict().superRefine(validateDiscoveryTokens);
const versionedDiscovery = legacyDiscovery.safeExtend({ schema_version: z.enum(['v2', 'v3']).optional() }).superRefine((v, ctx) => { if (v.schema_version === 'v3') { const result = discoveryV3InputSchema.safeParse({ network: v.network, tokens: v.tokens, exclude_tokens: v.exclude_tokens, min_liquidity_usd: v.min_liquidity_usd }); if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message }); } });
const versionedMovers = z.object({ schema_version: z.enum(['v1', 'v2']).optional(), networks: z.array(z.enum(['base', 'arbitrum', 'robinhood', 'ethereum', 'sui'])).optional(), direction: z.enum(['both', 'gainers', 'losers']).optional(), min_change_24h_pct: z.number().optional(), limit_per_chain: z.number().optional(), min_liquidity_usd: z.number().optional(), seed_tokens: z.record(z.string(), z.array(z.string())).optional(), exclude_tokens: z.record(z.string(), z.array(z.string())).optional() }).strict().superRefine((value, ctx) => {
  const { schema_version, ...input } = value;
  const result = (schema_version === 'v2' ? moversV2InputSchema : moverInputSchema).safeParse(input);
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});
export function assertVersionEnabled(operation: string, raw: unknown) {
  const version = raw && typeof raw === 'object' ? (raw as { schema_version?: unknown }).schema_version : undefined;
  if (operation === 'flashloan_discover_arbitrage_pools' && version === 'v3' && !v8Enabled('INVENTORY_V3') || operation === 'flashloan_get_token_movers' && version === 'v2' && (!v8Enabled('MOVERS_V2') || !v8Enabled('INVENTORY_V3'))) throw new ResearchError('FEATURE_DISABLED', 'Requested discovery version is disabled or its dependency is unavailable.');
}
export const candidateResearchSchema = z.object({
  schema: z.literal('flash-run-request/1'), round_id: z.string().min(1).max(128),
  network: evmNetwork, mode: z.literal('research'), snapshot: proofEnvelopeSchema,
  selection: z.object({ explicit_assets: z.array(address).max(PUBLIC_LIMITS.tokens), movers: z.boolean().default(false) }).strict(),
  policy: policy.nullable(),
  cost_evidence: z.object({ asset: address, network_cost_raw: uint, other_cost_raw: uint, evidence_hash: digest, expires_at: z.string().datetime() }).strict().nullable(),
  limits: z.object({ max_candidates: z.number().int().min(1).max(PUBLIC_LIMITS.tokens), max_evaluations: z.number().int().min(1).max(PUBLIC_LIMITS.evaluations), deadline_ms: z.number().int().min(1).max(PUBLIC_LIMITS.cpu_ms) }).strict(),
}).strict().superRefine((input, ctx) => {
  if (!input.selection.movers && !input.selection.explicit_assets.length) ctx.addIssue({ code: 'custom', message: 'Select explicit candidates or movers.' });
});
export const publicSchemas = {
  flashloan_get_watchlist_v1: watchlistInputSchema,
  flashloan_get_registry_v1: registryInputSchema,
  flashloan_get_arb_universe_v1: universeInputSchema,
  flashloan_quote_cycle_v1: quoteCycleInputSchema,
  flashloan_resolve_pool_inventory_v1: resolutionRequestSchema,
  flashloan_research_candidates_v2: candidateRequestV2Schema,
  flashloan_research_candidates_v1: candidateResearchSchema,
  get flashloan_get_token_movers() { return v8Enabled('MOVERS_V2') ? versionedMovers : moverInputSchema; },
  sui_ingest_pool_state: suiOperations.sui_ingest_pool_state.omit({ idempotency_key: true }).extend({ pools: suiOperations.sui_ingest_pool_state.shape.pools.max(PUBLIC_LIMITS.pools) }).strict(),
  sui_solve_arbitrage_routes: suiOperations.sui_solve_arbitrage_routes.omit({ idempotency_key: true, snapshot_id: true }).extend({ snapshot: proofEnvelopeSchema, policy: suiPolicy.extend({ max_evaluations: z.number().int().min(1).max(Math.min(8, PUBLIC_LIMITS.evaluations)).default(Math.min(4, PUBLIC_LIMITS.evaluations)) }) }).strict(),
  sui_simulate_ptb: z.object({ plan: proofEnvelopeSchema }).strict(),
  flashloan_capabilities: z.object({}).strict(),
  flashloan_rlusd_devtools_v1: rlusdDevtoolsSchema,
  get flashloan_discover_arbitrage_pools() { return v8Enabled('INVENTORY_V3') ? versionedDiscovery : legacyDiscovery; },
  flashloan_ingest_l2_tickmap_and_reserves: snapshot.extend({ pools: z.array(snapshot.shape.pools.element.extend({ word_range: z.number().int().min(0).max(1).default(1) })).min(1).max(PUBLIC_LIMITS.pools) }).strict(),
  flashloan_solve_dynamic_route_split: z.object({ snapshot: proofEnvelopeSchema, borrow_asset: address, policy }).strict(),
  flashloan_simulate_atomic_revm: operationSchemas.flashloan_simulate_atomic_revm.omit({ idempotency_key: true, plan_id: true }).extend({ plan: proofEnvelopeSchema }).strict(),
  xrpl_discover_arbitrage_routes: xrpl.extend({ assets: xrpl.shape.assets.max(PUBLIC_LIMITS.xrpl_assets) }).strict(),
  xrpl_simulate_arbitrage_route: operationSchemas.xrpl_simulate_arbitrage_route.omit({ idempotency_key: true, route_id: true }).extend({ routes: proofEnvelopeSchema }).strict(),
  xrpl_get_holder_report_v1: xrplHolderReportInput.extend({ routes: proofEnvelopeSchema }),
};
export type PublicOperation = keyof typeof publicSchemas;
/** Count the escaped text copy as well as structured content; character multiplication is unsafe. */
export function publicWireBytes(result: unknown) { return Buffer.byteLength(JSON.stringify({ result: { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] } })); }
/** Reject nesting/node bombs before recursive canonicalization or schema processing. */
export function assertPublicValue(value: unknown, maxBytes = PUBLIC_LIMITS.body_bytes) {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 100000 || item.depth > 40) throw new ResearchError('INPUT_BUDGET', 'JSON structure exceeds the public budget.');
    if (item.value && typeof item.value === 'object') for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) throw new ResearchError('INPUT_BUDGET', 'Payload exceeds the public byte budget.');
}
