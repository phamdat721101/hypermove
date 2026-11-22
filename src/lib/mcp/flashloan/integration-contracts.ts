import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import schema from './integration.schema.json';
import { CHAINS, ResearchError, hash, type EvmNetwork } from './contracts';

/** One shared wire schema; Zod is only the MCP SDK registration adapter. */
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export function validateIntegration<T>(name: keyof typeof schema.$defs, value: unknown): T {
  let validate = validators.get(name);
  if (!validate) { validate = ajv.compile({ $ref: schema.$id + '#/$defs/' + name }); validators.set(name, validate); }
  if (!validate(value)) throw new ResearchError('INVALID_INTEGRATION_' + name.toUpperCase(), 'Shared contract validation failed at ' + (validate.errors?.[0]?.instancePath || '/') + '.');
  const checkAmounts = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if ((key.endsWith('Raw') && !['planNetRaw', 'realizedNetRaw'].includes(key) || key === 'atBlock' || key === 'blockNumber') && typeof child === 'string') assertUint256(child);
      if (key !== 'payload') checkAmounts(child); // Existing proof payloads retain their kind-specific parser.
    }
  };
  checkAmounts(value);
  if (name === 'CandidateResultV2') {
    const result = value as { ledger: { items: { assetId: string; outcome: string; routeIds: string[]; nextDependency: string | null }[]; counts: Record<string, number> }; ranking: { targetAssetId: string; planHash: string }[]; researchPlans: { content_hash: string }[] };
    const { items, counts } = result.ledger;
    if (new Set(items.map((i) => i.assetId)).size !== items.length || counts.requested !== items.length || Object.entries(counts).filter(([key]) => key !== 'requested').reduce((n, [, count]) => n + count, 0) !== items.length) throw new ResearchError('INVALID_LEDGER', 'Candidate identity or outcome counts do not reconcile.');
    const outcomes = { discovered: 'DISCOVERED', resolved: 'RESOLVED', evaluated: 'EVALUATED', rejected: 'REJECTED', deferred: 'DEFERRED_BUDGET', incomplete: 'INCOMPLETE_DATA', unsupported: 'UNSUPPORTED' };
    if (Object.entries(outcomes).some(([label, outcome]) => counts[label] !== items.filter((i) => i.outcome === outcome).length)) throw new ResearchError('INVALID_LEDGER', 'Per-outcome counts do not reconcile.');
    if (items.some((i) => i.outcome === 'EVALUATED' && !i.routeIds.length || i.outcome !== 'EVALUATED' && !i.nextDependency)) throw new ResearchError('INVALID_LEDGER', 'Candidate disposition lacks route evidence or a dependency.');
    if (result.ranking.some((r) => !items.some((i) => i.assetId === r.targetAssetId && i.outcome === 'EVALUATED') || !result.researchPlans.some((p) => 'sha256:' + p.content_hash === r.planHash))) throw new ResearchError('INVALID_RANKING', 'Ranking is not bound to an evaluated target and exported plan.');
  }
  return value as T;
}
function requestAdapter(name: 'PoolResolutionRequest' | 'CandidateRequestV2') {
  return z.fromJSONSchema({ $schema: schema.$schema, $defs: schema.$defs, ...schema.$defs[name] } as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject;
}
export const resolutionRequestSchema = requestAdapter('PoolResolutionRequest');
export const candidateRequestV2Schema = requestAdapter('CandidateRequestV2');
export type Limits = { maxRpcCalls: number; maxEvaluations: number; maxPools: number; maxRoutes: number; deadlineMs: number; watchDurationMs: number };
export type EvidenceRef = { kind: 'source' | 'configuration' | 'canonical-state' | 'code'; contentHash: string; issuedAt: string; expiresAt: string | null; traceId: string; locator: string };
export type State = { chainId: string; blockNumber: string; blockHash: string; parentHash: string; observedAt: string; finality: 'latest'; stateDigest: string };
export type Support = { read: boolean; quote: boolean; prepare: boolean; simulate: boolean; execute: false; reasonCodes: string[] };
export type PoolKey = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
export type Asset = { assetId: string; chainId: string; kind: 'native' | 'erc20'; address: string | null; decimals: number; metadataRef: EvidenceRef };
export type PoolReference = { provider: string; providerPoolId: string; assetIds: string[] };
export type ResolutionRequest = { schema: 'pool-resolution-request/1'; roundId: string; chainId: string; references: PoolReference[]; managerMappingRef: EvidenceRef; atBlock: string | null; limits: Limits };
export type ResolvedPool = { schema: 'resolved-pool/1'; chainId: string; protocol: 'uniswap-v4'; provider: string; providerPoolId: string; manager: string; managerCodeHash: string; poolId: string; key: PoolKey; asset0: Asset; asset1: Asset; state: State; initializationRef: EvidenceRef; mappingRef: EvidenceRef; support: Support; sourceRefs: EvidenceRef[] };
export type ResolutionReport = { schema: 'pool-resolution-report/1'; roundId: string; chainId: string; resolved: ResolvedPool[]; unresolved: { provider: string; providerPoolId: string; reasonCode: string; nextDependency: string }[]; complete: boolean; rpcCallsUsed: number; sourceRefs: EvidenceRef[] };
export type CandidateRequestV2 = { schema: 'flash-candidate-request/2'; roundId: string; chainId: string; mode: 'research'; selection: { movers: boolean; explicitAssets: string[]; minReportedLiquidityUsd: string; maxCandidates: number }; fundingAnchor: string; profileResearchPolicy: { repaymentAssetId: string; principalCapRaw: string; minNetProfitRaw: string; comparison: 'gt'; maxPriceImpactBps: number; maxRoutes: number } | null; costEvidence: { schema: 'route-cost/1'; repaymentAssetId: string; state: State; networkNativeUpperRaw: string; networkCostUpperRaw: string; otherCostUpperRaw: string; gasReservationNativeRaw: string; valuationRefs: EvidenceRef[]; feeEvidenceRef: EvidenceRef; expiresAt: string } | null; snapshot: unknown | null; managerMappingRef: EvidenceRef | null; limits: Limits };
export const ZERO_ADDRESS = '0x' + '0'.repeat(40);
export function assetId(chain: string, currency: string) { return chain + (currency === ZERO_ADDRESS ? '/slip44:60' : '/erc20:' + currency); }
export function currencyAddress(chain: string, id: string) {
  if (!id.startsWith(chain + '/')) throw new ResearchError('WRONG_CHAIN', 'Asset belongs to another chain.');
  if (id === chain + '/slip44:60') return ZERO_ADDRESS;
  const match = /^eip155:[1-9][0-9]*\/erc20:(0x[0-9a-f]{40})$/.exec(id);
  if (!match || match[1] === ZERO_ADDRESS) throw new ResearchError('INVALID_ASSET', 'Invalid asset identity.');
  return match[1];
}
export function integrationNetwork(chain: string): EvmNetwork {
  const entry = Object.entries(CHAINS).find(([, id]) => chain === 'eip155:' + id);
  if (!entry) throw new ResearchError('WRONG_CHAIN', 'Chain is outside the reviewed server catalog.');
  return entry[0] as EvmNetwork;
}
export function evidence(kind: EvidenceRef['kind'], value: unknown, locator: string, traceId: string): EvidenceRef {
  return { kind, contentHash: 'sha256:' + hash(value), issuedAt: new Date().toISOString(), expiresAt: null, traceId, locator };
}
export function unsupportedSupport(...reasonCodes: string[]): Support { return { read: false, quote: false, prepare: false, simulate: false, execute: false, reasonCodes }; }
export function assertUint256(value: string) {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) throw new ResearchError('INVALID_AMOUNT', 'Amount exceeds canonical uint256.');
}
