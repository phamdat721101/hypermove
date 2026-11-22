import { resolve, join } from 'node:path';
import { runHarnessed, HarnessExecutionError } from 'nim-skill';
import { operationSchemas, operationEnabled, arbGtEnabled, groundTruthInputSchema, GROUND_TRUTH_OPERATION, errorResult, ResearchError, boundaryEvent, hash, VERSION, type Operation } from './contracts';
import { arbCacheKey, arbGroundTruthRefSchema, deploymentsVersion } from './arb-contracts';
import { measureArbGroundTruth, groundTruthKeyInputs, type GroundTruthInput, type GtNetwork } from './arb-ground-truth';
import { RoundBudget } from './transport';
import type { XrplSnapshot } from './xrpl';
import { ResearchEngine, type EngineOptions, type ComputeAdapter } from './engine';
import { ResearchAdmission } from './admission';
import { PublicResearch } from './public-worker';
import type { PublicOperation } from './public-contracts';
import { syncMemory } from './memory';
import { SHARED_OWNER, type Artifact, type Repository, type StoredJob } from './storage';
import { FinanceService, POSITIONS_JOB, type FinanceOptions } from './finance/engine';

/** Per-operation worker deadlines (file 11 #17); everything else keeps the 120 s default. */
const OPERATION_TIMEOUT_MS: Partial<Record<string, number>> = { [GROUND_TRUTH_OPERATION]: 300_000 };
/** The ground-truth round ends early enough to publish an INCONCLUSIVE document before the worker deadline. */
const GROUND_TRUTH_BUDGET = { maxRpcCalls: 6000, maxEvaluations: 0, deadlineMs: 270_000 };
/** ≈1 hour of blocks per network for the scheduled public refresh. */
const HOUR_BLOCKS: Record<GtNetwork, number> = { arbitrum: 14_400, base: 1_800, ethereum: 300 };
export type WorkerOptions = EngineOptions & { finance?: Omit<FinanceOptions, 'repo'>; repo: Repository; root?: string; timeoutMs?: number; concurrency?: number; publicKey?: string; compute?: ComputeAdapter; clock?: () => number };
export class ResearchWorker {
  private active = new Map<string, AbortController>();
  private claiming = 0;
  private readonly engine: ResearchEngine;
  private readonly admission: ResearchAdmission;
  readonly publicResearch?: PublicResearch;
  /** Finance lane (default off): same queue, admission and harness; separate contract. */
  readonly finance?: FinanceService;
  readonly root: string;
  constructor(readonly options: WorkerOptions) {
    this.root = options.root ?? resolve('services/flashloan/data'); this.engine = new ResearchEngine(options);
    this.admission = new ResearchAdmission(options.publicKey ? Math.min(2, options.concurrency ?? 2) : options.concurrency ?? 2, options.clock);
    if (options.finance) this.finance = new FinanceService({ ...options.finance, repo: options.repo, fetcher: options.finance.fetcher ?? options.fetcher, clock: options.finance.clock ?? options.clock });
    if (options.publicKey) this.publicResearch = new PublicResearch(this.engine, this.admission, options.publicKey, options.compute, options.clock);
  }
  publicDispatch(operation: PublicOperation, input: unknown, key: string, signal?: AbortSignal) {
    if (!this.publicResearch) throw new ResearchError('PUBLIC_DISABLED', 'Stateless public research is disabled.');
    return this.publicResearch.dispatch(operation, input, key, signal);
  }
  capabilities() {
    return { version: VERSION, chain_capabilities: this.engine.capabilities(), networks: Object.keys(this.options.endpoints), operations: Object.keys(operationSchemas).filter(operationEnabled), execution: false, generic_evm_spec: 'CANCUN', chain_native_verified: false, reviewed_deployments: this.options.deployments.map(({ network, address, adapter, version }) => ({ network, address, adapter, version })) };
  }
  async dispatch(owner: string, operation: Operation, raw: unknown) {
    if (!owner || owner === 'anonymous' || owner.length > 256) throw new ResearchError('AUTH_REQUIRED', 'An authenticated owner is required.');
    if (!(operation in operationSchemas) || !operationEnabled(operation)) throw new ResearchError('UNKNOWN_OPERATION', 'Unknown research operation.');
    const parsed = operationSchemas[operation].safeParse(raw);
    if (!parsed.success) { boundaryEvent('EDGE-04', 'INVALID_INPUT'); throw new ResearchError('INVALID_INPUT', 'Invalid research input.'); }
    const input = parsed.data;
    if (operation === 'flashloan_research_job') {
      const request = operationSchemas.flashloan_research_job.parse(input);
      if (request.operation === 'capabilities') return this.capabilities();
      if (request.operation === 'artifact') {
        if (!request.artifact_id) throw new ResearchError('INVALID_INPUT', 'artifact_id is required.');
        const artifact = await this.sharedFallback(() => this.options.repo.artifact(owner, request.artifact_id!), () => this.options.repo.artifact(SHARED_OWNER, request.artifact_id!));
        const serialized = JSON.stringify(artifact.data);
        if (serialized.length <= request.limit && request.offset === 0) return artifact;
        if (request.offset > serialized.length) throw new ResearchError('INVALID_INPUT', 'Artifact offset exceeds its length.');
        const end = Math.min(serialized.length, request.offset + request.limit);
        return { ...artifact, data: undefined, encoding: 'json', chunk: serialized.slice(request.offset, end), offset: request.offset, next_offset: end < serialized.length ? end : null, total_chars: serialized.length };
      }
      if (!request.job_id) throw new ResearchError('INVALID_INPUT', 'job_id is required.');
      if (request.operation === 'cancel') { const job = await this.options.repo.cancel(owner, request.job_id); this.active.get(job.id)?.abort(); return job; }
      return this.sharedFallback(() => this.options.repo.get(owner, request.job_id!), () => this.options.repo.getShared(request.job_id!));
    }
    // Ground truth is any-caller shared work: identical windows dedupe onto one @shared job (file 11 #20/#21).
    if (operation === GROUND_TRUTH_OPERATION) { const gt = input as GroundTruthInput; return this.options.repo.enqueueShared(operation, gt, this.groundTruthKey(gt.network, this.groundTruthDedupe(gt))); }
    return this.options.repo.enqueue(owner, operation, input);
  }
  /**
   * Shared-job polling (M5a open question): a caller polls a shared job and reads its shared artifacts with the same
   * `flashloan_research_job` get/artifact calls. Only when the private lookup misses, and only with the ground-truth flag
   * on, the unguessable id is looked up among `@shared` rows; private rows are never reachable this way.
   */
  private async sharedFallback<T>(owned: () => Promise<T>, shared: () => Promise<T>): Promise<T> {
    try { return await owned(); } catch (e) { if (!arbGtEnabled() || !(e instanceof ResearchError) || e.code !== 'NOT_FOUND') throw e; return shared(); }
  }
  private groundTruthKey(network: GtNetwork, inputs: Record<string, unknown>) {
    const registry = this.options.discoveryRegistry;
    if (!registry) throw new ResearchError('REGISTRY_UNCONFIGURED', 'Ground truth needs the reviewed discovery registry (FLASHLOAN_DISCOVERY_REGISTRY).');
    return arbCacheKey({ op: GROUND_TRUTH_OPERATION, network, registry, deployments_version: deploymentsVersion(this.options.deployments.filter((d) => d.network === network)), inputs });
  }
  /** Explicit windows key on the resolved window (the same key the result is published under); latest windows key on their request. */
  private groundTruthDedupe(input: GroundTruthInput) {
    return input.from_block !== undefined && input.to_block !== undefined ? groundTruthKeyInputs(input.from_block, input.to_block, input.include_v4, input.min_gross_usd)
      : { latest: true, from_block: input.from_block ?? null, to_block: input.to_block ?? null, window_blocks: input.window_blocks, include_v4: input.include_v4, min_gross_usd: input.min_gross_usd };
  }
  /** Hourly public refresh (server timer, FLASHLOAN_GT_SCHEDULE=1): one shared last-hour job per configured network. */
  async scheduleGroundTruth() {
    if (!arbGtEnabled()) return [];
    const jobs = [];
    for (const network of Object.keys(HOUR_BLOCKS) as GtNetwork[]) {
      if (!this.options.endpoints[network]) continue;
      const input = groundTruthInputSchema.parse({ idempotency_key: 'gt-schedule', network, window_blocks: HOUR_BLOCKS[network] });
      jobs.push(await this.options.repo.enqueueShared(GROUND_TRUTH_OPERATION, input, this.groundTruthKey(network, this.groundTruthDedupe(input))));
    }
    return jobs;
  }
  private async groundTruth(job: StoredJob, signal: AbortSignal) {
    const input = groundTruthInputSchema.parse(job.input), { repo } = this.options;
    const key = (inputs: Record<string, unknown>) => this.groundTruthKey(input.network, inputs);
    const ref = (artifact: Artifact, reused: boolean) => { const d = artifact.data as { outcome: 'SUCCESS' | 'EMPTY' | 'INCONCLUSIVE'; reason: string | null }; return { kind: 'arb_ground_truth_ref', data: arbGroundTruthRefSchema.parse({ schema_version: 'flashloan.arb.ground_truth_ref.v1', network: input.network, artifact_id: artifact.id, cache_key: artifact.cache_key, content_hash: artifact.content_hash, outcome: d.outcome, reason: d.reason, reused }) }; };
    if (input.from_block !== undefined && input.to_block !== undefined) {
      const hit = await repo.readSharedLatest('arb_ground_truth', key(groundTruthKeyInputs(input.from_block, input.to_block, input.include_v4, input.min_gross_usd)));
      if (hit && (hit.data as { outcome?: string }).outcome !== 'INCONCLUSIVE') return ref(hit, true);
    }
    const budget = new RoundBudget(GROUND_TRUTH_BUDGET, signal);
    try {
      const document = await measureArbGroundTruth({ rpc: this.engine.withBudget(budget).rpc(input.network), budget, network: input.network, registry: this.options.discoveryRegistry!, deployments: this.options.deployments,
        initializeIndex: this.options.initializeIndex, locators: this.options.initializations, cacheKey: key, publish: (kind, cacheKey, data) => repo.publishShared(kind, cacheKey, data) }, input);
      return ref(await repo.publishShared('arb_ground_truth', document.cache_key, document), false);
    } finally { budget.dispose(); }
  }
  async tick(): Promise<void> {
    if (this.active.size + this.claiming >= (this.options.concurrency ?? 2)) return;
    const release = this.admission.privateLease();
    if (!release) return;
    this.claiming++;
    let job: StoredJob | null;
    try { job = await this.options.repo.claim(); } catch (e) { release(); throw e; } finally { this.claiming--; }
    if (!job) { release(); return; }
    const controller = new AbortController(); this.active.set(job.id, controller);
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? OPERATION_TIMEOUT_MS[job.operation] ?? 120000);
    try {
      const result = await runHarnessed({ name: job.operation, version: VERSION,
        harness: {
          errorHandler: { retries: 0 },
          memory: { verifyCache: false, priors: true, store: join(this.root, 'harness', hash(job.owner), 'verify.jsonl') },
          knowledge: { root: join(this.root, 'knowledge', hash(job.owner)), projectId: 'flashloan-' + hash(job.owner).slice(0, 24), captureEpisodes: job.operation !== 'nim_memory_sync_flashloan_lesson' },
          cache: { provider: 'auto', strategy: 'prefix', roi: true },
          context: { maxInputTokens: 8000, onExceed: 'block' },
          enforcer: { mode: 'strict', maxHeals: 0, strategies: [{ kind: 'schema', required: ['kind', 'data'] }] },
          logCompact: { strategy: 'errors-only', maxLines: 40, escalateOnEmpty: true },
          monitor: { exporters: ['file'], traceFile: join(this.root, 'harness', hash(job.owner), 'traces.jsonl') },
        },
        execute: async () => this.execute(job, controller.signal),
      }, {}, { agentId: hash(job.owner) });
      controller.signal.throwIfAborted();
      // Shared (`@shared`) jobs have no owner to cancel them and private reads reject reserved owners; complete() still requires RUNNING.
      if (!job.owner.startsWith('@') && (await this.options.repo.get(job.owner, job.id)).state === 'CANCELLED') return;
      await this.options.repo.complete(job, result.output.kind, result.output.data);
    } catch (e) {
      const cause = e instanceof HarnessExecutionError ? e.error.cause : e;
      const error = controller.signal.aborted ? { code: 'DEADLINE_OR_CANCELLATION', message: 'Research exceeded its deadline or was cancelled.', retryable: true } : errorResult(cause);
      await this.options.repo.finish(job.id, error);
    } finally {
      clearTimeout(timer); this.active.delete(job.id); release();
      console.log(JSON.stringify({ event: 'flashloan.job_timing', operation: job.operation, job_id: job.id, elapsed_ms: Math.round((performance.now() - started) * 100) / 100 }));
    }
  }
  stop() { for (const controller of this.active.values()) controller.abort(); this.publicResearch?.stop(); }
  private async execute(job: StoredJob, signal: AbortSignal): Promise<{ kind: string; data: Record<string, unknown> }> {
    const { repo } = this.options;
    if (job.operation === POSITIONS_JOB) {
      if (!this.finance) throw new ResearchError('FEATURE_DISABLED', 'Finance is disabled on this worker.');
      return this.finance.executePositions(job, signal);
    }
    switch (job.operation as Operation) {
      case 'sui_ingest_pool_state': return { kind: 'sui-snapshot', data: await this.engine.suiSnapshot(operationSchemas.sui_ingest_pool_state.parse(job.input), signal) };
      case 'sui_solve_arbitrage_routes': {
        const input = operationSchemas.sui_solve_arbitrage_routes.parse(job.input), snapshot = await repo.artifact(job.owner, input.snapshot_id);
        if (snapshot.kind !== 'sui-snapshot') throw new ResearchError('ARTIFACT_KIND', 'Expected a Sui snapshot.');
        const result = await this.engine.suiSize(snapshot.data, input, signal);
        return { kind: 'sui-plan', data: result };
      }
      case 'sui_simulate_ptb': {
        const input = operationSchemas.sui_simulate_ptb.parse(job.input), artifact = await repo.artifact(job.owner, input.plan_id);
        if (artifact.kind !== 'sui-plan') throw new ResearchError('ARTIFACT_KIND', 'Expected a Sui plan.');
        return { kind: 'sui-simulation', data: await this.engine.suiSimulate((artifact.data as { solution: unknown }).solution, signal) };
      }
      case 'flashloan_discover_arbitrage_pools': return { kind: 'discovery', data: await this.engine.discover(operationSchemas.flashloan_discover_arbitrage_pools.parse(job.input), signal) };
      case 'flashloan_ingest_l2_tickmap_and_reserves': {
        const input = operationSchemas.flashloan_ingest_l2_tickmap_and_reserves.parse(job.input);
        const snapshot = await this.engine.snapshot(input, signal);
        return { kind: 'snapshot', data: snapshot };
      }
      case 'flashloan_solve_dynamic_route_split': {
        const input = operationSchemas.flashloan_solve_dynamic_route_split.parse(job.input);
        const artifact = await repo.artifact(job.owner, input.snapshot_id);
        if (artifact.kind !== 'snapshot') throw new ResearchError('INVALID_ARTIFACT', 'Expected an EVM snapshot.');
        const plan = await this.engine.size(artifact.data, input.snapshot_id, input.borrow_asset, input.policy, signal);
        return { kind: plan.solution ? 'plan' : 'report', data: plan };
      }
      case 'flashloan_simulate_atomic_revm': {
        const input = operationSchemas.flashloan_simulate_atomic_revm.parse(job.input);
        const plan = await repo.artifact(job.owner, input.plan_id);
        if (plan.kind !== 'plan') throw new ResearchError('INVALID_ARTIFACT', 'Expected a feasible plan.');
        return { kind: 'report', data: await this.engine.simulate(plan.data, input, signal) };
      }
      case 'xrpl_discover_arbitrage_routes': return { kind: 'xrpl-routes', data: await this.engine.xrplDiscover(operationSchemas.xrpl_discover_arbitrage_routes.parse(job.input), signal) };
      case 'xrpl_simulate_arbitrage_route': {
        const input = operationSchemas.xrpl_simulate_arbitrage_route.parse(job.input), routes = await repo.artifact(job.owner, input.route_id);
        if (routes.kind !== 'xrpl-routes') throw new ResearchError('INVALID_ARTIFACT', 'Expected a native XRPL route snapshot.');
        return { kind: 'report', data: await this.engine.xrplSimulate(routes.data as XrplSnapshot, input.transaction, signal) };
      }
      case GROUND_TRUTH_OPERATION: if (!arbGtEnabled()) throw new ResearchError('FEATURE_DISABLED', 'Ground truth is disabled on this worker.'); return this.groundTruth(job, signal);
      case 'nim_memory_sync_flashloan_lesson': return { kind: 'memory', data: { ...await syncMemory(join(this.root, 'knowledge'), job.owner, operationSchemas.nim_memory_sync_flashloan_lesson.parse(job.input), repo) } };
      default: throw new ResearchError('UNKNOWN_OPERATION', 'Unknown research operation.');
    }
  }
}
