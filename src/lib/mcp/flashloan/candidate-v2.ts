import { CHAINS, hash, ResearchError, riskPolicy, LENDER_PROVIDERS, lendersV1Enabled, type LenderProvider, type PoolRef } from './contracts';
import { evmSnapshotSchema, type EvmSnapshot } from './evm';
import type { ResearchEngine, ComputeAdapter } from './engine';
import type { solve } from './math';
import { quoteRoute, ceilDiv, lenderRoutablePools } from './math';
import { planSchema } from './simulation';
import { PublicProofs } from './public-proof';
import { PUBLIC_LIMITS, proofEnvelopeSchema, type ProofEnvelope } from './public-contracts';
import { RoundBudget } from './transport';
import { managerMapping, resolveInventory, stateIdentity } from './pool-resolution';
import { assetId, assertUint256, currencyAddress, evidence, integrationNetwork, unsupportedSupport, validateIntegration, ZERO_ADDRESS, type CandidateRequestV2, type PoolReference, type ResolutionReport, type Support } from './integration-contracts';

type Item = { assetId: string; sources: Array<'explicit' | 'movers'>; outcome: 'DISCOVERED' | 'RESOLVED' | 'EVALUATED' | 'REJECTED' | 'DEFERRED_BUDGET' | 'INCOMPLETE_DATA' | 'UNSUPPORTED'; stage: 'discovery' | 'identity' | 'snapshot' | 'quote' | 'solve'; reasonCode: string | null; nextDependency: string | null; poolIds: string[]; routeIds: string[]; support: Support; evidenceRefs: ReturnType<typeof evidence>[] };

/** Deterministic shortest connecting paths before extra cycle edges consume capacity. */
export function connectedPools<T>(pools: Array<{ id: string; assets: string[]; value: T }>, anchor: string, targets: string[], limit: number, check: () => void = () => undefined): T[] {
  if (pools.length > 256 || targets.length > 40) throw new ResearchError('GRAPH_BUDGET', 'Connecting graph exceeds its bounded metadata domain.');
  const ordered = [...pools].sort((a, b) => a.id.localeCompare(b.id));
  const adjacency = new Map<string, typeof ordered>();
  for (const pool of ordered) { check(); for (const asset of pool.assets) adjacency.set(asset, [...adjacency.get(asset) ?? [], pool]); }
  const chosen = new Map<string, typeof ordered[number]>();
  let steps = 0;
  const pathTo = (target: string, blocked?: string) => {
    const queue = [{ asset: anchor, path: [] as typeof ordered }], seen = new Set([anchor]);
    for (let at = 0; at < queue.length; at++) {
      check(); if (++steps > 32768) throw new ResearchError('GRAPH_BUDGET', 'Connecting graph traversal budget exhausted.');
      const node = queue[at];
      if (node.asset === target) return node.path;
      for (const pool of adjacency.get(node.asset) ?? []) {
        if (pool.id === blocked) continue;
        for (const next of pool.assets) if (!seen.has(next)) { seen.add(next); queue.push({ asset: next, path: [...node.path, pool] }); }
      }
    }
    return [];
  };
  const include = (path: typeof ordered) => {
    const additions = path.filter((p) => !chosen.has(p.id));
    if (chosen.size + additions.length <= limit) additions.forEach((p) => chosen.set(p.id, p));
  };
  for (const target of targets) include(pathTo(target));
  // A second path through an unseen hub can complete the cycle of a direct edge.
  for (const target of targets) {
    for (const edge of [...chosen.values()]) { if (chosen.size >= limit) break; include(pathTo(target, edge.id)); }
  }
  const reached = new Set([anchor, ...[...chosen.values()].flatMap((p) => p.assets)]);
  for (const pool of ordered) if (chosen.size < limit && pool.assets.every((a) => reached.has(a))) chosen.set(pool.id, pool);
  return [...chosen.values()].map((p) => p.value);
}

function costValid(input: CandidateRequestV2, snapshot: EvmSnapshot) {
  const cost = input.costEvidence;
  if (!cost || !input.profileResearchPolicy) return false;
  [cost.networkNativeUpperRaw, cost.networkCostUpperRaw, cost.otherCostUpperRaw, cost.gasReservationNativeRaw].forEach(assertUint256);
  if (BigInt(cost.networkNativeUpperRaw) > BigInt(cost.gasReservationNativeRaw)) return false;
  const state = cost.state;
  return cost.repaymentAssetId === input.fundingAnchor && input.profileResearchPolicy.repaymentAssetId === input.fundingAnchor &&
    state.chainId === input.chainId && state.blockNumber === BigInt(snapshot.block.number).toString() && state.blockHash === snapshot.block.hash && state.parentHash === snapshot.block.parentHash && state.stateDigest === 'sha256:' + hash(snapshot) &&
    Date.parse(cost.expiresAt) > Date.now() && cost.valuationRefs.length > 0 && [...cost.valuationRefs, cost.feeEvidenceRef].every((r) => Date.parse(r.issuedAt) <= Date.now() && (r.expiresAt === null || Date.parse(r.expiresAt) > Date.now()));
}

/** Research composition owns no signer, durable caller state, or execution admission. */
export async function researchCandidatesV2(engine: ResearchEngine, raw: unknown, proofs: PublicProofs, compute: ComputeAdapter, budget: RoundBudget) {
  const started = performance.now();
  const input = validateIntegration<CandidateRequestV2>('CandidateRequestV2', raw);
  const network = integrationNetwork(input.chainId), anchor = currencyAddress(input.chainId, input.fundingAnchor);
  if (!Number.isFinite(Number(input.selection.minReportedLiquidityUsd))) throw new ResearchError('INVALID_INPUT', 'Liquidity filter must be a finite decimal.');
  const sources = new Map<string, Array<'explicit' | 'movers'>>();
  for (const id of [...new Set(input.selection.explicitAssets)].sort()) { currencyAddress(input.chainId, id); sources.set(id, ['explicit']); }
  if (!sources.size && !input.selection.movers) throw new ResearchError('INVALID_INPUT', 'Select explicit targets or movers.');
  if (input.limits.watchDurationMs !== 0) throw new ResearchError('INVALID_INPUT', 'Public research does not run persistent watch jobs.');
  const reasonCodes: string[] = [], dependencies: string[] = [];
  const note = (code: string, dependency: string) => { if (!reasonCodes.includes(code) && reasonCodes.length < 32) reasonCodes.push(code); if (!dependencies.includes(dependency) && dependencies.length < 32) dependencies.push(dependency); };
  let resolution: ResolutionReport = { schema: 'pool-resolution-report/1', roundId: input.roundId, chainId: input.chainId, resolved: [], unresolved: [], complete: true, rpcCallsUsed: 0, sourceRefs: [] };
  let snapshot: EvmSnapshot | null = null, snapshotProof: ProofEnvelope | null = null;
  let search: ReturnType<typeof solve> | null = null;
  const plans: ProofEnvelope[] = [], ranking: Array<{ targetAssetId: string; planHash: string; repaymentAssetId: string; planNetRaw: string; basis: 'PLAN_CONTAINING_TARGET' }> = [];
  let selected: string[] = [], costsReady = false, coverageBlocked = false, pipelineFailed = false, inputBlocked = false, toolError = false;
  let effectivePolicy: unknown = null;
  const poolRefs: PoolRef[] = [];
  const maxPools = Math.min(input.limits.maxPools, PUBLIC_LIMITS.pools), maxTargets = Math.min(input.selection.maxCandidates, PUBLIC_LIMITS.tokens);
  try {
    if (input.selection.movers) {
      if (!['base', 'arbitrum', 'robinhood'].includes(network)) note('MOVERS_UNSUPPORTED', 'Use explicit targets on this chain.');
      else {
        const movers = await engine.movers({ networks: [network as 'base' | 'arbitrum' | 'robinhood'], direction: 'both', min_change_24h_pct: 10, limit_per_chain: 10, min_liquidity_usd: Number(input.selection.minReportedLiquidityUsd), seed_tokens: {} }, budget.signal, budget.remainingMs());
        const chain = movers.chains[0];
        if (chain.outcome === 'PARTIAL' || chain.outcome === 'UNAVAILABLE') note('DISCOVERY_PARTIAL', 'Retry bounded mover discovery when its provider is available.');
        for (const token of chain.tokens) {
          const id = assetId(input.chainId, token.token_id), previous = sources.get(id) ?? [];
          sources.set(id, [...new Set([...previous, 'movers' as const])]);
        }
      }
    }
    selected = [...sources.keys()].slice(0, Math.min(maxTargets, PUBLIC_LIMITS.tokens - (sources.has(input.fundingAnchor) ? 0 : 1)));
    if (input.snapshot !== null) {
      snapshotProof = proofEnvelopeSchema.parse(proofs.verify(input.snapshot, 'evm_snapshot'));
      snapshot = evmSnapshotSchema.parse(snapshotProof.payload);
      if (snapshot.network !== network || snapshot.chain_id !== CHAINS[network] || snapshot.lender.asset !== anchor || snapshot.pools.length > maxPools) throw new ResearchError('INVALID_SNAPSHOT', 'Snapshot chain, anchor or pool budget differs from the request.');
      await engine.canonical(snapshot, budget.signal);
    } else if (selected.length) {
      const tokens = [...new Set([...selected.map((id) => currencyAddress(input.chainId, id)), anchor])].filter((id) => id !== ZERO_ADDRESS);
      const inventory = await engine.discover({ idempotency_key: 'stateless-v2', network, tokens, min_liquidity_usd: Number(input.selection.minReportedLiquidityUsd), exclude_tokens: [], native_cursors: {}, native_page_size: 50, native_max_pages: 2 }, budget.signal);
      if (inventory.outcome === 'PARTIAL') note('DISCOVERY_PARTIAL', 'Complete the missing inventory provider reads.');
      const graphPools = [...inventory.pools].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 64);
      if (graphPools.length < inventory.pools.length) note('POOL_SELECTION_BUDGET', 'Narrow targets to cover pool metadata beyond the bounded 64-pool connecting graph.');
      const preferred = new Set(connectedPools(graphPools.map((p) => ({ id: p.id, assets: p.asset_ids.map((a) => assetId(input.chainId, a)), value: p.id })), input.fundingAnchor, selected, maxPools, () => budget.check()));
      const orderedPools = [...inventory.pools].sort((a, b) => Number(preferred.has(b.id)) - Number(preferred.has(a.id)) || a.id.localeCompare(b.id));
      const references: PoolReference[] = orderedPools.filter((p) => p.reference.kind === 'provider_opaque' || p.reference.kind === 'evm_v4').slice(0, 64).map((p) => ({ provider: p.provenance[0]?.source ?? 'inventory', providerPoolId: p.reference.kind === 'provider_opaque' ? p.reference.providerPoolId : p.reference.kind === 'evm_v4' ? p.reference.poolId : '', assetIds: p.asset_ids.map((a) => assetId(input.chainId, a)) }));
      if (inventory.pools.filter((p) => p.reference.kind === 'provider_opaque' || p.reference.kind === 'evm_v4').length > references.length) note('RESOLUTION_REFERENCE_BUDGET', 'Narrow discovery targets to export all pool reference dispositions.');
      resolution = await resolveInventory(engine, input.chainId, input.roundId, references, input.managerMappingRef, input.costEvidence?.state.blockNumber ?? null, budget, maxPools);
      for (const p of resolution.resolved.filter((p) => p.support.quote)) poolRefs.push({ address: p.poolId, adapter: 'UNISWAP_V4', manager: p.manager, pool_key: p.key, word_range: 1 });
      // Protocol labels never select an adapter; only the server deployment registry does.
      for (const p of graphPools) {
        if (p.reference.kind !== 'evm_contract') continue;
        const ref = p.reference;
        const d = engine.options.deployments.find((d) => d.network === network && d.address === ref.address && ['UNISWAP_V2', 'UNISWAP_V3', 'ALGEBRA', 'AERODROME_VOLATILE', 'AERODROME_STABLE', 'AERODROME_CLMM'].includes(d.adapter));
        if (d) poolRefs.push({ address: d.address, adapter: d.adapter as PoolRef['adapter'], word_range: 1 });
      }
      const deduped = [...new Map(poolRefs.map((p) => [(p.manager ?? '') + ':' + p.address, p])).values()];
      const connected = connectedPools(deduped.map((ref) => { const canonical = resolution.resolved.find((p) => p.poolId === ref.address && p.manager === ref.manager); const discovered = inventory.pools.find((p) => p.reference.kind === 'evm_contract' && p.reference.address === ref.address); return { id: (ref.manager ?? '') + ':' + ref.address, assets: canonical ? [canonical.asset0.assetId, canonical.asset1.assetId] : discovered?.asset_ids.map((a) => assetId(input.chainId, a)) ?? [], value: ref }; }), input.fundingAnchor, selected, maxPools, () => budget.check());
      poolRefs.splice(0, poolRefs.length, ...connected);
      if (resolution.unresolved.length) note('IDENTITY_INCOMPLETE', 'Resolve the per-pool dependencies retained in the resolution report.');
      if (!poolRefs.length) { coverageBlocked = true; note('TARGET_STATE_REQUIRED', 'Supply reviewed supported target pools and canonical snapshot coverage.'); }
      else if (anchor === ZERO_ADDRESS) { coverageBlocked = true; note('FUNDING_SOURCE_REQUIRED', 'The current ingestion lenders support ERC20 funding only; native identity is preserved.'); }
      else {
        engine.requireResearch(network);
        const lenders = engine.options.deployments.filter((d) => d.network === network && (LENDER_PROVIDERS as readonly string[]).includes(d.adapter) && (d.adapter !== 'MORPHO_BLUE' || lendersV1Enabled())).sort((a, b) => (a.adapter + a.address).localeCompare(b.adapter + b.address));
        for (const lender of lenders) {
          budget.check();
          try {
            snapshot = await engine.snapshot({ idempotency_key: 'stateless-v2', network, pools: poolRefs, lender: { provider: lender.adapter as LenderProvider, address: lender.address, asset: anchor } }, budget.signal, PUBLIC_LIMITS.ticks, input.costEvidence?.state.blockNumber);
            if (BigInt(snapshot.lender.capacity) <= 0n) { snapshot = null; continue; }
            break;
          } catch (error) { if (!(error instanceof ResearchError) || ['CANCELLED', 'ROUND_DEADLINE', 'RESOLUTION_BUDGET', 'REORG'].includes(error.code)) throw error; }
        }
        if (snapshot) snapshotProof = proofs.sign('evm_snapshot', snapshot);
        else { coverageBlocked = true; note('FUNDING_SOURCE_REQUIRED', 'Provide a reviewed lender with verified funding-asset capacity at this state.'); }
      }
    }
    const policy = input.profileResearchPolicy;
    if (snapshot) {
      [snapshot.lender.capacity, snapshot.lender.fee_numerator, snapshot.lender.fee_denominator].forEach(assertUint256);
      if (BigInt(snapshot.lender.fee_denominator) === 0n) throw new ResearchError('INVALID_SNAPSHOT', 'Lender fee denominator must be positive.');
    }
    if (policy) { assertUint256(policy.principalCapRaw); assertUint256(policy.minNetProfitRaw); currencyAddress(input.chainId, policy.repaymentAssetId); }
    if (snapshot && policy) {
      costsReady = costValid(input, snapshot);
      if (!costsReady) note('POLICY_OR_COST_REQUIRED', 'Supply fresh costs bound to the returned snapshot digest, block and repayment asset.');
      else {
        const threshold = BigInt(policy.minNetProfitRaw) + 1n;
        if (threshold >= 1n << 256n || policy.maxPriceImpactBps < 1 || policy.maxPriceImpactBps > 5000) throw new ResearchError('POLICY_UNSUPPORTED', 'Research policy cannot be represented by the reviewed solver.');
        const totalEvaluations = Math.min(input.limits.maxEvaluations, PUBLIC_LIMITS.evaluations);
        const solverPolicy = riskPolicy.parse({ max_principal: policy.principalCapRaw, min_profit: threshold.toString(), max_price_impact_bps: policy.maxPriceImpactBps, max_routes: Math.min(policy.maxRoutes, input.limits.maxRoutes, PUBLIC_LIMITS.routes), max_evaluations: Math.max(1, totalEvaluations - Math.min(selected.length, totalEvaluations - 1)), network_cost: (BigInt(input.costEvidence!.networkCostUpperRaw) + BigInt(input.costEvidence!.otherCostUpperRaw)).toString() });
        effectivePolicy = solverPolicy;
        const pools = lenderRoutablePools(snapshot.pools, snapshot.lender);
        const computeMs = Math.max(1, Math.min(PUBLIC_LIMITS.cpu_ms, budget.remainingMs())), computeDeadline = performance.now() + computeMs;
        search = await compute({ kind: 'solve', snapshot: { ...snapshot, pools }, asset: anchor, policy: solverPolicy, search: { targets: selected.map((id) => currencyAddress(input.chainId, id)), deadline_ms: computeMs, refine: true } }, budget.signal) as ReturnType<typeof solve>;
        budget.evaluations(search.evaluations);
        await engine.canonical(snapshot, budget.signal);
        proofs.verify(snapshotProof, 'evm_snapshot');
        if (!costValid(input, snapshot)) throw new ResearchError('STALE_COST', 'Cost evidence expired during search.');
        let planBytes = 0;
        for (const target of search.target_results ?? []) {
          if (!target.solution || BigInt(target.net_raw) <= BigInt(policy.minNetProfitRaw)) continue;
          if (performance.now() >= computeDeadline) { note('COMPUTE_BUDGET', 'Reserve compute time for independent plan replay.'); break; }
          if (budget.evaluationsUsed >= totalEvaluations) { note('PLAN_VERIFICATION_BUDGET', 'Increase available evaluation budget to verify the remaining qualified plans.'); break; }
          budget.evaluations(1);
          let state = new Map(pools.map((p) => [p.address, p]));
          const principal = BigInt(target.solution.principal), unused = BigInt(target.solution.unused);
          let terminal = unused;
          if (target.solution.allocations.reduce((sum, a) => sum + BigInt(a.amount), 0n) + unused !== principal || principal > BigInt(policy.principalCapRaw) || principal > BigInt(snapshot.lender.capacity)) throw new ResearchError('INVALID_OUTPUT', 'Plan principal does not conserve or exceeds capacity.');
          for (const allocation of target.solution.allocations) {
            const replay = quoteRoute(allocation.route, state, BigInt(allocation.amount), solverPolicy.max_price_impact_bps);
            state = replay.state; terminal += replay.output;
          }
          const fee = ceilDiv(principal * BigInt(snapshot.lender.fee_numerator), BigInt(snapshot.lender.fee_denominator));
          const net = terminal - principal - fee - BigInt(solverPolicy.network_cost);
          if (performance.now() >= computeDeadline) { note('COMPUTE_BUDGET', 'Plan replay exhausted the shared compute time budget.'); break; }
          if (terminal.toString() !== target.solution.expected_output || fee.toString() !== target.solution.lender_fee || net.toString() !== target.solution.expected_profit || net.toString() !== target.net_raw || !target.solution.allocations.some((a) => a.route.hops.some((h) => h.token_in === target.asset || h.token_out === target.asset))) throw new ResearchError('INVALID_OUTPUT', 'Plan replay or target inclusion differs from search output.');
          const plan = { ...search, solution: target.solution, snapshot_id: snapshotProof!.content_hash, snapshot, borrow_asset: anchor, policy: solverPolicy, cost_evidence: { asset: anchor, network_cost_raw: input.costEvidence!.networkCostUpperRaw, other_cost_raw: input.costEvidence!.otherCostUpperRaw, evidence_hash: hash(input.costEvidence), expires_at: input.costEvidence!.expiresAt } };
          planSchema.parse(plan);
          const evidenceExpiry = [...input.costEvidence!.valuationRefs, input.costEvidence!.feeEvidenceRef].flatMap((r) => r.expiresAt === null ? [] : [Date.parse(r.expiresAt)]);
          const sealed = proofs.sign('evm_plan', plan, new Date(Math.min(Date.parse(snapshotProof!.expires_at), Date.parse(input.costEvidence!.expiresAt), ...evidenceExpiry)).toISOString());
          const bytes = Buffer.byteLength(JSON.stringify(sealed));
          if (planBytes + bytes > Math.min(PUBLIC_LIMITS.envelope_bytes, Math.floor(PUBLIC_LIMITS.body_bytes / 4))) { note('PLAN_EXPORT_BUDGET', 'Narrow targets or routes to export remaining qualified plan proofs.'); continue; }
          const previous = plans.find((p) => p.content_hash === sealed.content_hash);
          if (!previous) { plans.push(sealed); planBytes += bytes; }
          ranking.push({ targetAssetId: assetId(input.chainId, target.asset), planHash: 'sha256:' + sealed.content_hash, repaymentAssetId: input.fundingAnchor, planNetRaw: target.net_raw, basis: 'PLAN_CONTAINING_TARGET' });
        }
      }
    } else if (snapshot) note('POLICY_OR_COST_REQUIRED', 'Supply research policy and fresh snapshot-bound route costs.');
  } catch (error) {
    const e = error instanceof ResearchError ? error : new ResearchError('TOOL_ERROR', 'Research dependency failed validation.');
    if (['INVALID_PROOF', 'PROOF_EXPIRED', 'PROOF_VERSION', 'PROOF_KIND', 'REORG', 'INVALID_SNAPSHOT', 'WRONG_CHAIN', 'INVALID_OUTPUT'].includes(e.code)) throw e;
    pipelineFailed = true;
    inputBlocked = ['POLICY_UNSUPPORTED', 'INVALID_AMOUNT', 'INVALID_ASSET', 'STALE_COST'].includes(e.code);
    toolError = e.code === 'TOOL_ERROR';
    coverageBlocked ||= ['CAPABILITY_UNAVAILABLE', 'NETWORK_UNCONFIGURED'].includes(e.code);
    note(e.code, e.message);
  }
  const items: Item[] = [...sources].map(([id, origins]) => {
    const address = currencyAddress(input.chainId, id);
    const routes = (search?.route_catalog ?? []).filter((r) => r.hops.some((h) => h.token_in === address || h.token_out === address));
    const attempted = routes.filter((r) => search?.evaluated_route_ids?.includes(r.id));
    const pools = resolution.resolved.filter((p) => p.asset0.assetId === id || p.asset1.assetId === id);
    const present = snapshot?.pools.some((p) => p.token0 === address || p.token1 === address);
    const deferred = !selected.includes(id);
    const outcome: Item['outcome'] = deferred ? 'DEFERRED_BUDGET' : attempted.length ? 'EVALUATED' : present ? 'INCOMPLETE_DATA' : pools.length ? 'RESOLVED' : coverageBlocked ? 'INCOMPLETE_DATA' : 'DISCOVERED';
    return { assetId: id, sources: origins, outcome, stage: attempted.length ? 'solve' : present ? 'snapshot' : pools.length ? 'identity' : 'discovery', reasonCode: deferred ? 'TARGET_BUDGET' : attempted.length ? 'AMOUNT_QUOTE_ATTEMPTED' : reasonCodes[0] ?? 'TARGET_STATE_REQUIRED', nextDependency: attempted.length ? null : deferred ? 'Retry this target within the advertised candidate/pool budget.' : dependencies[0] ?? 'Supply supported canonical target state.', poolIds: pools.map((p) => p.poolId), routeIds: attempted.map((r) => r.id), support: { ...unsupportedSupport(), read: Boolean(present || pools.length), quote: Boolean(attempted.length) }, evidenceRefs: pools.flatMap((p) => p.sourceRefs).slice(0, 32) };
  });
  ranking.sort((a, b) => BigInt(a.planNetRaw) === BigInt(b.planNetRaw) ? a.targetAssetId.localeCompare(b.targetAssetId) : BigInt(a.planNetRaw) > BigInt(b.planNetRaw) ? -1 : 1);
  const complete = Boolean(search && search.search.termination === 'GRID_COMPLETE' && !search.route_enumeration_truncated && !search.rejected_evaluations.INSUFFICIENT_TICK_COVERAGE && items.length && items.every((i) => i.outcome === 'EVALUATED') && !reasonCodes.length);
  const status = coverageBlocked ? 'COVERAGE_BLOCKED' : inputBlocked ? 'INPUT_BLOCKED' : toolError ? 'TOOL_ERROR' : pipelineFailed ? 'INCONCLUSIVE' : !snapshot ? 'DISCOVERY_ONLY' : !costsReady ? 'INPUT_BLOCKED' : !complete ? 'INCONCLUSIVE' : ranking.length ? 'MODEL_OPPORTUNITY' : 'NO_OPPORTUNITY_WITHIN_DOMAIN';
  const labels = { discovered: 'DISCOVERED', resolved: 'RESOLVED', evaluated: 'EVALUATED', rejected: 'REJECTED', deferred: 'DEFERRED_BUDGET', incomplete: 'INCOMPLETE_DATA', unsupported: 'UNSUPPORTED' };
  const result = {
    schema: 'flash-candidate-research/2', roundId: input.roundId, chainId: input.chainId, status, execution: false,
    ledger: {
      schema: 'candidate-ledger/2', roundId: input.roundId, chainId: input.chainId, items,
      counts: { requested: items.length, ...Object.fromEntries(Object.entries(labels).map(([key, outcome]) => [key, items.filter((i) => i.outcome === outcome).length])) } as Record<string, number>,
      exhaustive: false, sourceRefs: [],
    },
    resolution: { ...resolution, rpcCallsUsed: budget.rpcCallsUsed }, snapshot: snapshotProof,
    researchPlan: ranking.length ? plans.find((p) => 'sha256:' + p.content_hash === ranking[0].planHash) ?? null : null,
    researchPlans: plans, ranking,
    search: {
      attempted: search?.evaluations ?? 0, complete,
      termination: search?.search.termination ?? reasonCodes[0] ?? 'DISCOVERY_ONLY',
      domainHash: search && snapshot ? 'sha256:' + hash({
        domain: 'flash/research-domain/1', snapshot: hash(snapshot), selected, routes: search.route_catalog, policy: effectivePolicy,
        limits: { ...input.limits, maxPools, maxCandidates: maxTargets, maxEvaluations: budget.limits.maxEvaluations, maxRpcCalls: budget.limits.maxRpcCalls },
        principalDomain: { scales: 32, cap: search.search.max_principal }, cost: input.costEvidence, revision: 'coarse4-refine1024/1',
      }) : null,
    },
    reasonCodes, nextDependencies: dependencies,
  };

  const wireFits = () => Buffer.byteLength(JSON.stringify({ result: { structuredContent: { data: result }, content: [{ type: 'text', text: JSON.stringify({ data: result }) }] } })) < PUBLIC_LIMITS.body_bytes - 8192;
  if (!wireFits()) {
    result.researchPlan = null; result.researchPlans = []; result.ranking = [];
    note('PLAN_EXPORT_BUDGET', 'Narrow the snapshot/target domain to export qualified proofs within the full MCP wire budget.');
    result.status = 'INCONCLUSIVE'; result.search.complete = false;
    if (!wireFits()) { result.snapshot = null; note('SNAPSHOT_EXPORT_BUDGET', 'Retrieve a smaller canonical snapshot through the existing ingestion tool.'); }
  }
  const verified = validateIntegration<Record<string, unknown>>('CandidateResultV2', result);
  console.info(JSON.stringify({ event: 'flashloan.candidate_v2', round_id: input.roundId, status: result.status, targets: items.length, deferred: result.ledger.counts.deferred, incomplete: result.ledger.counts.incomplete, rpc_calls_used: budget.rpcCallsUsed, evaluations_used: budget.evaluationsUsed, search_termination: result.search.termination, elapsed_ms: Math.round(performance.now() - started) }));
  return verified;
}
