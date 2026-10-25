import { createHash } from 'node:crypto';
import { z } from 'zod';

export const VERSION = 'flashloan-research/1';
export const evmNetwork = z.enum(['ethereum', 'arbitrum', 'base']);
export const network = z.enum(['ethereum', 'arbitrum', 'base', 'xrpl']);
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase());
export const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((value) => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n, 'Amount exceeds uint256.');
export const hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const xrplAccount = z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
export const xrplAsset = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('xrp') }).strict(),
  z.object({ kind: z.literal('issued'), currency: z.string().regex(/^(?!XRP$)(?:[\x21-\x7E]{3}|[A-Fa-f0-9]{40})$/), issuer: xrplAccount }).strict(),
]);
export const poolRef = z.object({ address, adapter: z.enum(['UNISWAP_V2', 'UNISWAP_V3', 'ALGEBRA', 'AERODROME_VOLATILE', 'AERODROME_STABLE', 'AERODROME_CLMM']), word_range: z.number().int().min(0).max(16).default(3) }).strict();
export const riskPolicy = z.object({
  max_principal: uint, min_profit: uint.default('0'), max_price_impact_bps: z.number().int().min(1).max(5000).default(100),
  max_routes: z.number().int().min(1).max(5).default(5), max_evaluations: z.number().int().min(1).max(10000).default(1000),
  network_cost: uint, min_weight_bps: z.number().int().min(0).max(10000).default(0),
  min_deployment_bps: z.number().int().min(0).max(10000).default(0),
}).strict();
const start = { idempotency_key: z.string().min(1).max(128) };
export const operationSchemas = {
  flashloan_discover_arbitrage_pools: z.object({ ...start, network: evmNetwork, tokens: z.array(address).min(1).max(300), min_liquidity_usd: z.number().finite().min(0).default(15000), exclude_tokens: z.array(address).max(300).default([]) }).strict(),
  flashloan_ingest_l2_tickmap_and_reserves: z.object({ ...start, network: evmNetwork, pools: z.array(poolRef).min(1).max(20), lender: z.object({ provider: z.enum(['AAVE_V3', 'BALANCER_V2', 'UNISWAP_V3_FLASH']), address, asset: address }).strict() }).strict(),
  flashloan_solve_dynamic_route_split: z.object({ ...start, snapshot_id: digest, borrow_asset: address, policy: riskPolicy }).strict(),
  flashloan_simulate_atomic_revm: z.object({ ...start, plan_id: digest, caller: address, executor_mode: z.enum(['existing', 'fixture']), executor: address }).strict(),
  xrpl_discover_arbitrage_routes: z.object({ ...start, network: z.literal('xrpl'), assets: z.array(xrplAsset).min(2).max(10), funding: z.discriminatedUnion('mode', [z.object({ mode: z.literal('account'), account: xrplAccount }).strict(), z.object({ mode: z.literal('hypothetical'), balances: z.array(z.object({ asset: xrplAsset, amount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/) }).strict()).min(1).max(10) }).strict()]) }).strict(),
  xrpl_simulate_arbitrage_route: z.object({ ...start, route_id: digest, transaction: z.record(z.string(), z.unknown()).optional() }).strict(),
  nim_memory_sync_flashloan_lesson: z.object({ ...start, operation: z.enum(['RETRIEVE', 'PROPOSE', 'VALIDATE', 'COMMIT']), query: z.string().min(3).max(8000).optional(), report_id: digest.optional(), proposal_id: z.string().min(1).max(128).optional() }).strict(),
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
export const CHAINS = { ethereum: 1, arbitrum: 42161, base: 8453 } as const;
/** Secret-free delivery boundary markers; never log raw RPC URLs or payloads. */
export function boundaryEvent(edge: 'EDGE-01' | 'EDGE-02' | 'EDGE-03' | 'EDGE-04' | 'EDGE-05', code: string): void {
  console.warn(JSON.stringify({ event: 'flashloan.' + edge, code }));
}
