import { z } from 'zod';
import { coinType, suiObjectId } from './networks';

export const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine((v) => BigInt(v) < 1n << 64n, 'Amount exceeds u64.');
const digest = z.string().min(1).max(128);
export const suiDeploymentSchema = z.object({
  protocol: z.enum(['CETUS_CLMM', 'DEEPBOOK_V3']), original_package: suiObjectId,
  published_at: suiObjectId, package_digest: digest, version: z.string().min(1).max(100),
  config_id: suiObjectId.optional(), config_digest: digest.optional(),
}).strict();
export type SuiDeployment = z.infer<typeof suiDeploymentSchema>;
export const suiPoolRef = z.object({ object_id: suiObjectId, protocol: z.enum(['CETUS_CLMM', 'DEEPBOOK_V3']) }).strict();
export const suiSnapshotSchema = z.object({
  network: z.literal('sui'), chain_identifier: z.string().min(1), checkpoint: z.object({ sequence_number: u64, digest }).strict(),
  pools: z.array(z.object({ ...suiPoolRef.shape, coin_a: coinType, coin_b: coinType, version: u64, digest, funding_fee: z.object({ pips: z.number().int().min(0).max(999999), source: z.enum(['NATIVE_CURRENT_VIEW', 'PROTOCOL_VERSION']), observed_at: z.string().datetime() }).strict(), content_bcs: z.string().min(1).max(1000000), initial_shared_version: u64, deployment: suiDeploymentSchema }).strict()).min(1).max(21),
  lender: suiPoolRef, observed_at: z.string().datetime(), warnings: z.array(z.string()),
}).strict();
export type SuiSnapshot = z.infer<typeof suiSnapshotSchema>;
export const suiPolicy = z.object({ max_principal: u64, min_profit: u64.default('0'), network_cost: u64, max_evaluations: z.number().int().min(1).max(32).default(8) }).strict();
export const suiHop = z.object({ pool: suiObjectId, token_in: coinType, token_out: coinType }).strict();
export const suiPlanSchema = z.object({ snapshot: suiSnapshotSchema, sender: suiObjectId, borrow_asset: coinType, principal: u64, route: z.array(suiHop).min(2).max(4), policy: suiPolicy, expected_profit: z.string().regex(/^-?\d+$/) }).strict();
export type SuiPlan = z.infer<typeof suiPlanSchema>;
export const suiOperations = {
  sui_ingest_pool_state: z.object({ idempotency_key: z.string().min(1).max(128), network: z.literal('sui'), pools: z.array(suiPoolRef).min(1).max(20), lender: suiPoolRef }).strict(),
  sui_solve_arbitrage_routes: z.object({ idempotency_key: z.string().min(1).max(128), snapshot_id: z.string().regex(/^[a-f0-9]{64}$/), sender: suiObjectId, borrow_asset: coinType, policy: suiPolicy }).strict(),
  sui_simulate_ptb: z.object({ idempotency_key: z.string().min(1).max(128), plan_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
};
