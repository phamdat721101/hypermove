import { researchCandidates } from './candidates';
import { runRlusdDevtools } from './rlusd-devtools';
import { researchCandidatesV2 } from './candidate-v2';
import { RoundBudget } from './transport';
import { integrationNetwork, validateIntegration, type ResolutionRequest, type CandidateRequestV2 } from './integration-contracts';
import { managerMapping, resolveInventory } from './pool-resolution';
import { randomUUID } from 'node:crypto';
import { runHarnessed, HarnessExecutionError } from 'nim-skill';
import { hash, ResearchError, errorResult, boundaryEvent, operationSchemas, UNIVERSE_OPERATION, universeInputSchema, QUOTE_CYCLE_OPERATION, quoteCycleInputSchema, CHAINS } from './contracts';
import { arbUniversePayloadSchema, arbCycleQuotePayloadSchema } from './arb-contracts';
import { readLatestGroundTruth, loadDatasetEvents } from './arb-ground-truth';
import { universeCacheKey, fitUniverse, universeFitBytes, loadPinnedUniverse, UNIVERSE_FRESH_MS } from './arb-universe';
import type { Repository } from './storage';
import { moverInputSchema } from './movers';
import { DiscoveryRegistry } from './discovery-registry';
import { discoveryV3InputSchema, moversV2InputSchema, registryInputSchema, watchlistInputSchema, v8Enabled } from './v8-contracts';
import { evmSnapshotSchema, EvmReader } from './evm';
import { planSchema, quoteCycle } from './simulation';
import type { XrplSnapshot } from './xrpl';
import { xrplHolderReport } from './xrpl-holder-report';
import { ResearchEngine, type ComputeAdapter } from './engine';
import { computeIsolated } from './compute';
import { ResearchAdmission } from './admission';
import { PublicProofs } from './public-proof';
import { assertPublicValue, assertVersionEnabled, PUBLIC_LIMITS, PUBLIC_VERSION, publicSchemas, publicOperationEnabled, integrationEnabled, resolutionEnabled, watchlistEnabled, publicWireBytes, type PublicOperation } from './public-contracts';

export class PublicResearch {
  readonly proofs: PublicProofs;
  private readonly active = new Set<AbortController>();
  constructor(private readonly engine: ResearchEngine, private readonly admission: ResearchAdmission, key: string, private readonly compute: ComputeAdapter = computeIsolated, private readonly clock = Date.now, private readonly repo?: Repository) {
    this.proofs = new PublicProofs(key, hash({ version: PUBLIC_VERSION, limits: PUBLIC_LIMITS, research_registry: engine.registryHash(), deployments: [...engine.options.deployments].sort((a, b) => (a.network + a.address + a.adapter).localeCompare(b.network + b.address + b.adapter)) }), clock);
  }
  capabilities() {
    const integration = integrationEnabled() || resolutionEnabled(), chains = this.engine.capabilities();
    const chainCapabilities = chains.map((chain) => !integration ? chain : {
      ...chain,
      identity_resolution: chain.family === 'evm' && Boolean(this.engine.options.endpoints[chain.network as keyof typeof this.engine.options.endpoints]) && this.engine.options.deployments.some((d) => d.network === chain.network && d.adapter === 'UNISWAP_V4'),
      snapshot: chain.research, quote: chain.research, native_simulation: false, execution: false,
    });
    return {
      schema_version: PUBLIC_VERSION, chain_capabilities: chainCapabilities, auth: 'none', state: 'stateless',
      networks: Object.keys(this.engine.options.endpoints), operations: Object.keys(publicSchemas).filter(publicOperationEnabled),
      limits: PUBLIC_LIMITS, registry_version: this.proofs.registry,
      reviewed_deployments: this.engine.options.deployments.map(({ network, address, adapter, version }) => ({ network, address, adapter, version })),
      execution: false, chain_native_verified: false, can_execute: false,
      ...((v8Enabled('INVENTORY_V3') || v8Enabled('MOVERS_V2') || v8Enabled('REGISTRY_V1')) ? { discovery_v8: { inventory_v3: v8Enabled('INVENTORY_V3'), movers_v2: v8Enabled('MOVERS_V2') && v8Enabled('INVENTORY_V3'), watchlist_v1: watchlistEnabled(), registry_v1: v8Enabled('REGISTRY_V1'), registry_version: (this.engine.options.discoveryRegistry ?? new DiscoveryRegistry()).version, limits: { max_tokens: 30, max_pools: 400, deadline_ms: 25000, ttl_seconds: 120 } } } : {}),
      ...(integration ? { integration: {
        schema: 'flashloan-integration/1', rpc_calls: 100,
        manager_mappings: chains.filter((chain) => chain.family === 'evm' && Boolean(this.engine.options.endpoints[chain.network as keyof typeof this.engine.options.endpoints])).map((chain) => managerMapping(this.engine, 'eip155:' + ('chain_id' in chain ? chain.chain_id : ''), 'capabilities')),
      } } : {}),
    };
  }

  async dispatch(operation: PublicOperation, raw: unknown, admissionKey: string, signal?: AbortSignal) {
    assertPublicValue(raw);
    assertVersionEnabled(operation, raw);
    if (!Object.hasOwn(publicSchemas, operation) || !publicOperationEnabled(operation)) throw new ResearchError('UNKNOWN_OPERATION', 'Unknown public research tool.');
    const parsed = publicSchemas[operation].safeParse(raw);
    if (!parsed.success) { boundaryEvent('EDGE-04', 'PUBLIC_INVALID_INPUT'); throw new ResearchError('INVALID_INPUT', 'Invalid public research input.'); }
    if (operation === 'flashloan_capabilities') return this.response(operation, this.capabilities());
    // F2 (file 11 #20/#21): the universe is read from the shared artifact before any admission lease; misses enqueue a bounded shared build.
    if (operation === UNIVERSE_OPERATION) return this.universe(parsed.data);
    const release = this.admission.publicLease(admissionKey);
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const v8 = operation === 'flashloan_get_watchlist_v1' || (raw as { schema_version?: string })?.schema_version === 'v3' || operation === 'flashloan_get_token_movers' && (raw as { schema_version?: string })?.schema_version === 'v2';
    const timer = setTimeout(abort, v8 ? Math.min(25000, PUBLIC_LIMITS.operation_ms) : operation === 'flashloan_research_candidates_v1' ? publicSchemas.flashloan_research_candidates_v1.parse(raw).limits.deadline_ms : operation === 'flashloan_simulate_atomic_revm' || operation.startsWith('sui_') ? PUBLIC_LIMITS.simulation_ms : PUBLIC_LIMITS.operation_ms);
    const started = performance.now(); const requestId = randomUUID();
    try {
      const output = await runHarnessed({ name: 'public.' + operation, version: PUBLIC_VERSION, harness: {
        errorHandler: { retries: 0 }, memory: false, knowledge: false,
        enforcer: { mode: 'strict', maxHeals: 0, strategies: [{ kind: 'schema', required: ['schema_version', 'request_id', 'operation', 'ok', 'data', 'execution'] }] },
        logCompact: { strategy: 'errors-only', maxLines: 20, escalateOnEmpty: true }, monitor: { exporters: [] },
      }, execute: async () => this.response(operation, await this.execute(operation, parsed.data, controller.signal), requestId) }, {}, { agentId: 'public-stateless' });
      controller.signal.throwIfAborted();
      return output.output;
    } catch (error) {
      if (controller.signal.aborted) { boundaryEvent('EDGE-02', 'PUBLIC_CANCELLED'); throw new ResearchError('DEADLINE_OR_CANCELLATION', 'Public research timed out or disconnected.', true); }
      const cause = error instanceof HarnessExecutionError ? error.error.cause : error;
      if (cause instanceof ResearchError) throw cause;
      const failure = errorResult(cause); throw new ResearchError(failure.code, failure.message, failure.retryable);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active.delete(controller); release();
      console.log(JSON.stringify({ event: 'flashloan.public_timing', operation, request_id: requestId, elapsed_ms: Math.round(performance.now() - started) }));
    }
  }
  stop() { for (const controller of this.active) controller.abort(); }
  private async universe(raw: unknown) {
    const input = universeInputSchema.parse(raw), registry = this.engine.options.discoveryRegistry;
    if (!this.repo || !registry) throw new ResearchError('PUBLIC_UNCONFIGURED', 'The arb universe needs shared storage and the reviewed discovery registry.');
    const key = universeCacheKey(registry, this.engine.options.deployments, input);
    const hit = await this.repo.readSharedLatest('arb_universe', key);
    const built = hit ? Date.parse(hit.created_at) : NaN, now = this.clock();
    if (hit && now - built < UNIVERSE_FRESH_MS) {
      const payload = fitUniverse(arbUniversePayloadSchema.parse(hit.data), universeFitBytes());
      return this.response(UNIVERSE_OPERATION, this.proofs.sign('evm_universe', payload, new Date(built + UNIVERSE_FRESH_MS).toISOString()));
    }
    const job = await this.repo.enqueueShared(UNIVERSE_OPERATION, { ...input }, key); // returns the queued/running job for this key
    boundaryEvent('EDGE-05', 'UNIVERSE_WARMING');
    throw new ResearchError('UNIVERSE_WARMING', 'The arb universe for this input is being built (job ' + job.id + '); retry shortly.', true);
  }
  private response(operation: PublicOperation, data: unknown, requestId = randomUUID()) {
    const result = { schema_version: PUBLIC_VERSION, request_id: requestId, operation, ok: true as const, data, warnings: data && typeof data === 'object' && 'warnings' in data ? (data as { warnings: unknown }).warnings : [], execution: false as const };
    try { assertPublicValue(result); } catch { throw new ResearchError('RESPONSE_TOO_LARGE', 'Research output exceeds the public budget; reduce the request.'); }
    // MCP repeats structured content as JSON text; budget the actual wire envelope.
    if (publicWireBytes(result) > PUBLIC_LIMITS.body_bytes - 1024) throw new ResearchError('RESPONSE_TOO_LARGE', 'Research output exceeds the MCP wire budget; reduce the request.');
    boundaryEvent('EDGE-05', 'PUBLIC_OUTPUT_VERIFIED');
    return result;
  }
  private async execute(operation: PublicOperation, raw: unknown, signal: AbortSignal): Promise<unknown> {
    switch (operation) {
      case QUOTE_CYCLE_OPERATION: {
        // PRD-D (file 11 §D): one computation slot, data only; universe and GT evidence come from shared artifacts.
        const input = quoteCycleInputSchema.parse(raw), registry = this.engine.options.discoveryRegistry, repo = this.repo, { deployments } = this.engine.options;
        if (!registry) throw new ResearchError('PUBLIC_UNCONFIGURED', 'The cycle quote needs the reviewed discovery registry.');
        if ('cycle_id' in input.cycle && !repo) throw new ResearchError('PUBLIC_UNCONFIGURED', 'A universe cycle quote needs shared storage.');
        const budget = new RoundBudget({ maxRpcCalls: 200, maxEvaluations: 0, deadlineMs: PUBLIC_LIMITS.operation_ms }, signal);
        try {
          const universe = 'cycle_id' in input.cycle ? await loadPinnedUniverse(repo!, registry, deployments, input.network, input.cycle.universe_input, input.cycle.universe_content_hash) : null;
          const gt = repo ? await readLatestGroundTruth(repo, registry, deployments, input.network) : null;
          const quote = await quoteCycle({ reader: new EvmReader(this.engine.withBudget(budget).rpc(input.network), input.network, deployments), signal: budget.signal, registry, universe, groundTruth: gt?.document ?? null,
            datasetEvents: gt && repo ? (block) => loadDatasetEvents(repo, gt.document, block) : undefined }, input);
          return this.proofs.sign('evm_cycle_quote', arbCycleQuotePayloadSchema.parse({ schema_version: 'flashloan.arb.cycle_quote.v1', network: input.network, chain_id: CHAINS[input.network], quote }));
        } finally { budget.dispose(); }
      }
      case 'flashloan_resolve_pool_inventory_v1':
      case 'flashloan_research_candidates_v2': {
        const input = operation === 'flashloan_resolve_pool_inventory_v1' ? validateIntegration<ResolutionRequest>('PoolResolutionRequest', raw) : validateIntegration<CandidateRequestV2>('CandidateRequestV2', raw);
        integrationNetwork(input.chainId);
        const budget = new RoundBudget({ maxRpcCalls: Math.min(100, input.limits.maxRpcCalls), maxEvaluations: Math.min(PUBLIC_LIMITS.evaluations, input.limits.maxEvaluations), deadlineMs: Math.min(PUBLIC_LIMITS.operation_ms, input.limits.deadlineMs) }, signal);
        const engine = this.engine.withBudget(budget);
        try {
          if (operation === 'flashloan_research_candidates_v2') return await researchCandidatesV2(engine, input, this.proofs, this.compute, budget);
          const request = input as ResolutionRequest;
          if (request.limits.watchDurationMs !== 0) throw new ResearchError('INVALID_INPUT', 'Public resolution does not run watch jobs.');
          return await resolveInventory(engine, input.chainId, input.roundId, request.references, request.managerMappingRef, request.atBlock, budget, Math.min(PUBLIC_LIMITS.pools, input.limits.maxPools));
        } finally { budget.dispose(); }
      }
      case 'flashloan_research_candidates_v1': {
        const input = publicSchemas.flashloan_research_candidates_v1.parse(raw);
        const proof = this.proofs.verify(input.snapshot, 'evm_snapshot');
        const snapshot = evmSnapshotSchema.parse(proof.payload);
        if (snapshot.pools.length > PUBLIC_LIMITS.pools) throw new ResearchError('INPUT_BUDGET', 'Snapshot exceeds public pool limit.');
        await this.engine.canonical(snapshot, signal);
        const result = await researchCandidates(this.engine, input, snapshot, this.compute, signal);
        this.proofs.verify(input.snapshot, 'evm_snapshot');
        await this.engine.canonical(snapshot, signal);
        if (result.best_qualified && input.cost_evidence && Date.parse(input.cost_evidence.expires_at) <= Date.now()) throw new ResearchError('STALE_COST', 'Cost evidence expired during research.');
        if (result.best_qualified) {
          planSchema.parse(result.best_qualified.plan);
          result.best_qualified.plan = this.proofs.sign('evm_plan', result.best_qualified.plan, new Date(Math.min(Date.parse(proof.expires_at), Date.parse(input.cost_evidence!.expires_at))).toISOString());
        }
        return result;
      }
      case 'flashloan_rlusd_devtools_v1': return runRlusdDevtools(this.engine, publicSchemas.flashloan_rlusd_devtools_v1.parse(raw), signal);
      case 'flashloan_get_registry_v1': return (this.engine.options.discoveryRegistry ?? new DiscoveryRegistry()).document(registryInputSchema.parse(raw).networks);
      case 'flashloan_get_watchlist_v1': return this.engine.watchlist(watchlistInputSchema.parse(raw), signal);
      case 'flashloan_get_token_movers': {
        const { schema_version, ...input } = raw as Record<string, unknown>;
        return schema_version === 'v2' ? this.engine.moversV2(moversV2InputSchema.parse(input), signal) : this.engine.movers(moverInputSchema.parse(input), signal, Math.max(1, Math.floor(PUBLIC_LIMITS.operation_ms * 0.8)));
      }
      case 'sui_ingest_pool_state': {
        const snapshot = await this.engine.suiSnapshot({ ...publicSchemas.sui_ingest_pool_state.parse(raw), idempotency_key: 'stateless' }, signal);
        return this.proofs.sign('sui_snapshot', snapshot);
      }
      case 'sui_solve_arbitrage_routes': {
        const input = publicSchemas.sui_solve_arbitrage_routes.parse(raw), proof = this.proofs.verify(input.snapshot, 'sui_snapshot');
        const result = await this.engine.suiSize(proof.payload, { ...input, snapshot_id: proof.content_hash, idempotency_key: 'stateless' }, signal);
        return result.solution ? { ...result, solution: this.proofs.sign('sui_plan', result.solution, proof.expires_at) } : result;
      }
      case 'sui_simulate_ptb': {
        const input = publicSchemas.sui_simulate_ptb.parse(raw), proof = this.proofs.verify(input.plan, 'sui_plan');
        return this.engine.suiSimulate(proof.payload, signal);
      }
      case 'flashloan_discover_arbitrage_pools': {
        const { schema_version, ...input } = raw as Record<string, unknown>;
        return schema_version === 'v3' ? this.engine.discoverV3(discoveryV3InputSchema.parse({ network: input.network, tokens: input.tokens, exclude_tokens: input.exclude_tokens, min_liquidity_usd: input.min_liquidity_usd }), signal) : this.engine.discover(operationSchemas.flashloan_discover_arbitrage_pools.parse({ ...input, idempotency_key: 'stateless' }), signal);
      }
      case 'flashloan_ingest_l2_tickmap_and_reserves': {
        const snapshot = await this.engine.snapshot({ ...publicSchemas.flashloan_ingest_l2_tickmap_and_reserves.parse(raw), idempotency_key: 'stateless' }, signal, PUBLIC_LIMITS.ticks);
        return this.proofs.sign('evm_snapshot', snapshot);
      }
      case 'flashloan_solve_dynamic_route_split': {
        const input = publicSchemas.flashloan_solve_dynamic_route_split.parse(raw);
        const proof = this.proofs.verify(input.snapshot, 'evm_snapshot');
        const snapshot = evmSnapshotSchema.parse(proof.payload);
        await this.engine.canonical(snapshot, signal);
        const plan = await this.engine.size(snapshot, proof.content_hash, input.borrow_asset, input.policy, signal, this.compute);
        if (!['FEASIBLE', 'NO_OPPORTUNITY', 'INCONCLUSIVE'].includes(plan.status)) throw new ResearchError('INVALID_OUTPUT', 'Search returned an invalid outcome.');
        if (plan.solution) { planSchema.parse(plan); return this.proofs.sign('evm_plan', plan, proof.expires_at); }
        return plan;
      }
      case 'flashloan_simulate_atomic_revm': {
        const input = publicSchemas.flashloan_simulate_atomic_revm.parse(raw);
        const proof = this.proofs.verify(input.plan, 'evm_plan');
        const plan = planSchema.parse(proof.payload);
        return this.engine.simulate(plan, { idempotency_key: 'stateless', plan_id: proof.content_hash, caller: input.caller, executor: input.executor, executor_mode: input.executor_mode }, signal);
      }
      case 'xrpl_discover_arbitrage_routes': {
        const snapshot = await this.engine.xrplDiscover({ ...publicSchemas.xrpl_discover_arbitrage_routes.parse(raw), idempotency_key: 'stateless' }, signal);
        const routes = await this.compute({ kind: 'xrpl', snapshot }, signal);
        return this.proofs.sign('xrpl_routes', { ...snapshot, routes });
      }
      case 'xrpl_simulate_arbitrage_route': {
        const input = publicSchemas.xrpl_simulate_arbitrage_route.parse(raw);
        const proof = this.proofs.verify(input.routes, 'xrpl_routes');
        return this.engine.xrplSimulate(proof.payload as unknown as XrplSnapshot, input.transaction, signal, this.compute);
      }
      case 'xrpl_get_holder_report_v1': {
        const { routes, ...input } = publicSchemas.xrpl_get_holder_report_v1.parse(raw);
        const proof = this.proofs.verify(routes, 'xrpl_routes');
        return xrplHolderReport(proof, proof.payload as unknown as XrplSnapshot, input);
      }
      default: throw new ResearchError('UNKNOWN_OPERATION', 'Unknown public research tool.');
    }
  }
}
