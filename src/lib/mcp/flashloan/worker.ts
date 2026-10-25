import { resolve, join } from 'node:path';
import { runHarnessed, HarnessExecutionError } from 'nim-skill';
import { z } from 'zod';
import { operationSchemas, errorResult, ResearchError, boundaryEvent, hash, VERSION, type Operation } from './contracts';
import { DexScreener } from './discovery';
import { EvmReader, evmSnapshotSchema, type Deployment } from './evm';
import { solve } from './math';
import { simulatePlan, type EngineAdapter } from './simulation';
import { XrplReader, type XrplSnapshot } from './xrpl';
import { JsonClient } from './transport';
import { syncMemory } from './memory';
import type { Repository, StoredJob } from './storage';

export type WorkerOptions = { repo: Repository; endpoints: Partial<Record<'ethereum' | 'arbitrum' | 'base' | 'xrpl', string>>; deployments: Deployment[]; root?: string; fetcher?: typeof fetch; engine?: EngineAdapter; timeoutMs?: number; concurrency?: number };
export class ResearchWorker {
  private active = new Map<string, AbortController>();
  private claiming = 0;
  private readonly dex: DexScreener;
  readonly root: string;
  constructor(readonly options: WorkerOptions) { this.root = options.root ?? resolve('services/flashloan/data'); this.dex = new DexScreener(options.fetcher); }
  capabilities() {
    return { version: VERSION, networks: Object.keys(this.options.endpoints), operations: Object.keys(operationSchemas), execution: false, generic_evm_spec: 'CANCUN', chain_native_verified: false, reviewed_deployments: this.options.deployments.map(({ network, address, adapter, version }) => ({ network, address, adapter, version })) };
  }
  async dispatch(owner: string, operation: Operation, raw: unknown) {
    if (!owner || owner === 'anonymous' || owner.length > 256) throw new ResearchError('AUTH_REQUIRED', 'An authenticated owner is required.');
    if (!(operation in operationSchemas)) throw new ResearchError('UNKNOWN_OPERATION', 'Unknown research operation.');
    const parsed = operationSchemas[operation].safeParse(raw);
    if (!parsed.success) { boundaryEvent('EDGE-04', 'INVALID_INPUT'); throw new ResearchError('INVALID_INPUT', 'Invalid research input.'); }
    const input = parsed.data;
    if (operation === 'flashloan_research_job') {
      const request = operationSchemas.flashloan_research_job.parse(input);
      if (request.operation === 'capabilities') return this.capabilities();
      if (request.operation === 'artifact') {
        if (!request.artifact_id) throw new ResearchError('INVALID_INPUT', 'artifact_id is required.');
        const artifact = await this.options.repo.artifact(owner, request.artifact_id);
        const serialized = JSON.stringify(artifact.data);
        if (serialized.length <= request.limit && request.offset === 0) return artifact;
        if (request.offset > serialized.length) throw new ResearchError('INVALID_INPUT', 'Artifact offset exceeds its length.');
        const end = Math.min(serialized.length, request.offset + request.limit);
        return { ...artifact, data: undefined, encoding: 'json', chunk: serialized.slice(request.offset, end), offset: request.offset, next_offset: end < serialized.length ? end : null, total_chars: serialized.length };
      }
      if (!request.job_id) throw new ResearchError('INVALID_INPUT', 'job_id is required.');
      if (request.operation === 'cancel') { const job = await this.options.repo.cancel(owner, request.job_id); this.active.get(job.id)?.abort(); return job; }
      return this.options.repo.get(owner, request.job_id);
    }
    return this.options.repo.enqueue(owner, operation, input);
  }
  async tick(): Promise<void> {
    if (this.active.size + this.claiming >= (this.options.concurrency ?? 2)) return;
    this.claiming++;
    let job: StoredJob | null;
    try { job = await this.options.repo.claim(); } finally { this.claiming--; }
    if (!job) return;
    const controller = new AbortController(); this.active.set(job.id, controller);
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120000);
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
      const state = await this.options.repo.get(job.owner, job.id);
      if (state.state === 'CANCELLED') return;
      await this.options.repo.complete(job, result.output.kind, result.output.data);
    } catch (e) {
      const cause = e instanceof HarnessExecutionError ? e.error.cause : e;
      const error = controller.signal.aborted ? { code: 'DEADLINE_OR_CANCELLATION', message: 'Research exceeded its deadline or was cancelled.', retryable: true } : errorResult(cause);
      await this.options.repo.finish(job.id, error);
    } finally {
      clearTimeout(timer); this.active.delete(job.id);
      console.log(JSON.stringify({ event: 'flashloan.job_timing', operation: job.operation, job_id: job.id, elapsed_ms: Math.round((performance.now() - started) * 100) / 100 }));
    }
  }
  stop() { for (const controller of this.active.values()) controller.abort(); }
  private rpc(network: keyof WorkerOptions['endpoints']) {
    const endpoint = this.options.endpoints[network]; if (!endpoint) throw new ResearchError('NETWORK_UNCONFIGURED', 'This network endpoint is not configured.');
    return new JsonClient(endpoint, this.options.fetcher);
  }
  private async execute(job: StoredJob, signal: AbortSignal): Promise<{ kind: string; data: Record<string, unknown> }> {
    const { repo } = this.options;
    switch (job.operation as Operation) {
      case 'flashloan_discover_arbitrage_pools': return { kind: 'discovery', data: await this.dex.discover(operationSchemas.flashloan_discover_arbitrage_pools.parse(job.input), signal) };
      case 'flashloan_ingest_l2_tickmap_and_reserves': {
        const input = operationSchemas.flashloan_ingest_l2_tickmap_and_reserves.parse(job.input);
        const snapshot = await new EvmReader(this.rpc(input.network), input.network, this.options.deployments).snapshot(input, signal);
        return { kind: 'snapshot', data: snapshot };
      }
      case 'flashloan_solve_dynamic_route_split': {
        const input = operationSchemas.flashloan_solve_dynamic_route_split.parse(job.input);
        const artifact = await repo.artifact(job.owner, input.snapshot_id);
        if (artifact.kind !== 'snapshot') throw new ResearchError('INVALID_ARTIFACT', 'Expected an EVM snapshot.');
        const snapshot = evmSnapshotSchema.parse(artifact.data);
        if (snapshot.lender.asset !== input.borrow_asset) throw new ResearchError('INVALID_ASSET', 'Borrow asset does not match the snapshot lender.');
        const pools = snapshot.lender.provider === 'UNISWAP_V3_FLASH' ? snapshot.pools.filter((p) => p.address !== snapshot.lender.address) : snapshot.pools;
        const solution = solve(pools, input.borrow_asset, snapshot.lender, input.policy);
        return { kind: solution.solution ? 'plan' : 'report', data: { ...solution, snapshot_id: input.snapshot_id, snapshot, borrow_asset: input.borrow_asset, policy: input.policy } };
      }
      case 'flashloan_simulate_atomic_revm': {
        const input = operationSchemas.flashloan_simulate_atomic_revm.parse(job.input);
        const plan = await repo.artifact(job.owner, input.plan_id);
        if (plan.kind !== 'plan') throw new ResearchError('INVALID_ARTIFACT', 'Expected a feasible plan.');
        const n = z.enum(['ethereum', 'arbitrum', 'base']).parse((plan.data as Record<string, any>).snapshot.network);
        return { kind: 'report', data: await simulatePlan(new EvmReader(this.rpc(n), n, this.options.deployments), plan.data, input, this.options.engine, signal) };
      }
      case 'xrpl_discover_arbitrage_routes': return { kind: 'xrpl-routes', data: await new XrplReader(this.rpc('xrpl')).discover(operationSchemas.xrpl_discover_arbitrage_routes.parse(job.input), signal) };
      case 'xrpl_simulate_arbitrage_route': {
        const input = operationSchemas.xrpl_simulate_arbitrage_route.parse(job.input), routes = await repo.artifact(job.owner, input.route_id);
        if (routes.kind !== 'xrpl-routes') throw new ResearchError('INVALID_ARTIFACT', 'Expected a native XRPL route snapshot.');
        return { kind: 'report', data: await new XrplReader(this.rpc('xrpl')).simulate(routes.data as XrplSnapshot, input.transaction, signal) };
      }
      case 'nim_memory_sync_flashloan_lesson': return { kind: 'memory', data: { ...await syncMemory(join(this.root, 'knowledge'), job.owner, operationSchemas.nim_memory_sync_flashloan_lesson.parse(job.input), repo) } };
      default: throw new ResearchError('UNKNOWN_OPERATION', 'Unknown research operation.');
    }
  }
}
