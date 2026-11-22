import { z } from 'zod';
import { CHAINS, hash, ResearchError, uint, address } from './contracts';
import { moverInputSchema } from './movers';
import type { EvmSnapshot } from './evm';
import type { ResearchEngine, ComputeAdapter } from './engine';
import { candidateResearchSchema } from './public-contracts';
import type { solve } from './math';

const outcome = z.enum(['EVALUATED', 'REJECTED', 'DEFERRED_BUDGET', 'INCOMPLETE_DATA', 'UNSUPPORTED']);
const entry = z.object({ asset_id: address, sources: z.array(z.enum(['explicit', 'movers'])), outcome, reason_code: z.string(), evaluated_route_ids: z.array(z.string()), next_dependency: z.string().nullable() }).strict();
export const candidateResultSchema = z.object({
  schema: z.literal('flash-candidate-research/1'), round_id: z.string(), chain_id: z.number().int(),
  status: z.enum(['FEASIBLE', 'NO_OPPORTUNITY', 'INCONCLUSIVE', 'INPUT_BLOCKED']), execution: z.literal(false),
  snapshot_hash: z.string(), policy_hash: z.string().nullable(), cost_evidence_hash: z.string().nullable(),
  candidate_ledger: z.object({ items: z.array(entry).max(40), counts: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
  search: z.object({ attempted: z.number().int().nonnegative(), complete: z.boolean(), termination: z.string(), global_optimum_proven: z.literal(false), allocation_step_bps: z.literal(2500), rejected_by_reason: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
  ranking: z.array(z.object({ asset: address, plan_net_raw: z.string().regex(/^-?(0|[1-9][0-9]*)$/), principal_raw: uint, plan_route_ids: z.array(z.string()), funding_asset: address, basis: z.literal('PLAN_CONTAINING_TARGET'), label: z.enum(['MODEL_QUALIFIED', 'DIAGNOSTIC']) }).strict()).max(30),
  best_qualified: z.object({ label: z.literal('MODEL_QUALIFIED'), funding_asset: address, principal_raw: uint, unused_raw: uint, terminal_raw: uint, lender_fee_raw: uint, network_cost_raw: uint, other_cost_raw: uint, net_raw: z.string().regex(/^-?(0|[1-9][0-9]*)$/), plan: z.record(z.string(), z.unknown()) }).strict().nullable(),
  coverage: z.object({ scope: z.literal('supplied_snapshot'), exhaustive: z.literal(false), discovery_outcome: z.string(), route_enumeration_truncated: z.boolean() }).strict(),
  warnings: z.array(z.string()),
}).strict().superRefine((result, ctx) => {
  if (new Set(result.candidate_ledger.items.map((i) => i.asset_id)).size !== result.candidate_ledger.items.length) ctx.addIssue({ code: 'custom', message: 'Duplicate candidate identity.' });
  if (result.candidate_ledger.items.some((i) => i.outcome === 'EVALUATED' && !i.evaluated_route_ids.length)) ctx.addIssue({ code: 'custom', message: 'Evaluation requires target route evidence.' });
});

/** Host-selected targets are evaluated only against the exact proven snapshot. */
export async function researchCandidates(engine: ResearchEngine, input: z.infer<typeof candidateResearchSchema>, snapshot: EvmSnapshot, compute: ComputeAdapter, signal: AbortSignal) {
  if (snapshot.network !== input.network || snapshot.chain_id !== CHAINS[input.network] || snapshot.lender.asset !== input.cost_evidence?.asset && input.cost_evidence !== null) throw new ResearchError('INVALID_ASSET', 'Snapshot network or cost asset differs from request.');
  const sources = new Map<string, Array<'explicit' | 'movers'>>();
  for (const token of [...new Set(input.selection.explicit_assets)].sort()) sources.set(token, ['explicit']);
  let discovery = 'NOT_REQUESTED';
  if (input.selection.movers) {
    if (!['base', 'arbitrum', 'robinhood'].includes(input.network)) discovery = 'UNSUPPORTED';
    else {
      const movers = await engine.movers(moverInputSchema.parse({ networks: [input.network] }), signal);
      discovery = movers.chains[0].outcome;
      for (const token of movers.chains[0].tokens) sources.set(token.token_id, [...(sources.get(token.token_id) ?? []), 'movers']);
    }
  }
  signal.throwIfAborted();
  const selected = [...sources.keys()].slice(0, input.limits.max_candidates);
  const cost = input.cost_evidence;
  const blocked = !input.policy || !cost || Date.parse(cost.expires_at) <= Date.now() || BigInt(cost.network_cost_raw) + BigInt(cost.other_cost_raw) < BigInt(input.policy.network_cost);
  const policy = input.policy && cost ? { ...input.policy, max_evaluations: Math.min(input.policy.max_evaluations, input.limits.max_evaluations), network_cost: (BigInt(cost.network_cost_raw) + BigInt(cost.other_cost_raw)).toString() } : null;
  let search: ReturnType<typeof solve> | null = null;
  if (!blocked && policy && selected.length) {
    if (BigInt(snapshot.lender.fee_denominator) <= 0n) throw new ResearchError('INVALID_INPUT', 'Lender fee denominator must be positive.');
    const pools = snapshot.lender.provider === 'UNISWAP_V3_FLASH' ? snapshot.pools.filter((p) => p.address !== snapshot.lender.address) : snapshot.pools;
    search = await compute({ kind: 'solve', snapshot: { ...snapshot, pools }, asset: snapshot.lender.asset, policy, search: { targets: selected, deadline_ms: input.limits.deadline_ms } }, signal) as ReturnType<typeof solve>;
  }
  const routes = search?.route_catalog ?? [];
  const evaluated = new Set(search?.evaluated_route_ids ?? []);
  const truncated = search?.route_enumeration_truncated ?? false;
  const complete = Boolean(search && search.search.termination === 'GRID_COMPLETE' && !truncated && !search.rejected_evaluations.INSUFFICIENT_TICK_COVERAGE);
  const items = [...sources].map(([asset_id, origins]) => {
    const containing = routes.filter((r) => r.hops.some((h) => h.token_in === asset_id || h.token_out === asset_id));
    const evaluated_route_ids = containing.filter((r) => evaluated.has(r.id)).map((r) => r.id);
    const inSnapshot = snapshot.pools.some((p) => p.token0 === asset_id || p.token1 === asset_id);
    const state = !selected.includes(asset_id) ? 'DEFERRED_BUDGET' : blocked ? 'INCOMPLETE_DATA' : evaluated_route_ids.length ? 'EVALUATED' : !inSnapshot ? 'INCOMPLETE_DATA' : complete && !containing.length ? 'REJECTED' : 'DEFERRED_BUDGET';
    return { asset_id, sources: origins, outcome: state, reason_code: state === 'EVALUATED' ? 'AMOUNT_QUOTE_ATTEMPTED' : blocked ? 'POLICY_OR_COST_REQUIRED' : !inSnapshot ? 'TARGET_SNAPSHOT_REQUIRED' : state === 'REJECTED' ? 'NO_ROUTE_IN_SUPPLIED_SNAPSHOT' : 'SEARCH_BUDGET', evaluated_route_ids, next_dependency: state === 'INCOMPLETE_DATA' ? blocked ? 'Supply valid policy and fresh cost evidence' : 'Discover and ingest verified target pools' : null };
  });
  const solution = search?.solution;
  const allEvaluated = items.every((i) => i.outcome === 'EVALUATED' || i.outcome === 'REJECTED');
  return candidateResultSchema.parse({ schema: 'flash-candidate-research/1', round_id: input.round_id, chain_id: snapshot.chain_id, execution: false,
    status: blocked ? 'INPUT_BLOCKED' : !allEvaluated || !complete || discovery === 'UNAVAILABLE' || discovery === 'PARTIAL' || discovery === 'UNSUPPORTED' ? 'INCONCLUSIVE' : solution ? 'FEASIBLE' : 'NO_OPPORTUNITY',
    snapshot_hash: hash(snapshot), policy_hash: policy ? hash(policy) : null, cost_evidence_hash: cost ? hash(cost) : null,
    candidate_ledger: { items, counts: Object.fromEntries(outcome.options.map((o) => [o, items.filter((i) => i.outcome === o).length])) },
    search: { attempted: search?.evaluations ?? 0, complete, termination: search?.search.termination ?? 'INPUT_BLOCKED', global_optimum_proven: false, allocation_step_bps: 2500, rejected_by_reason: search?.rejected_evaluations ?? {} },
    ranking: (search?.target_results ?? []).sort((a, b) => BigInt(a.net_raw) === BigInt(b.net_raw) ? a.asset.localeCompare(b.asset) : BigInt(a.net_raw) > BigInt(b.net_raw) ? -1 : 1).map((r) => ({ asset: r.asset, plan_net_raw: r.net_raw, principal_raw: r.principal_raw, plan_route_ids: r.route_ids, basis: 'PLAN_CONTAINING_TARGET', funding_asset: snapshot.lender.asset, label: policy && BigInt(r.net_raw) >= BigInt(policy.min_profit) ? 'MODEL_QUALIFIED' : 'DIAGNOSTIC' })),
    best_qualified: solution && policy && cost ? { label: 'MODEL_QUALIFIED', funding_asset: snapshot.lender.asset, principal_raw: solution.principal, unused_raw: solution.unused, terminal_raw: solution.expected_output, lender_fee_raw: solution.lender_fee, network_cost_raw: cost.network_cost_raw, other_cost_raw: cost.other_cost_raw, net_raw: solution.expected_profit, plan: { ...search, snapshot_id: hash(snapshot), snapshot, borrow_asset: snapshot.lender.asset, policy, cost_evidence: cost } } : null,
    coverage: { scope: 'supplied_snapshot', exhaustive: false, discovery_outcome: discovery, route_enumeration_truncated: truncated },
    warnings: ['Ranking reports total plan economics, not profit attributable to an individual token.', 'Cost evidence is caller-supplied research evidence, not verified execution authority.', 'Token transfer restrictions remain unknown; modeled results require native simulation.', 'Discovery and snapshot ingestion use existing tools; absent target state is reported explicitly.'],
  });
}
