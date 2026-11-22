import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { withClient } from '../../db';
import { hash, digest, ResearchError, boundaryEvent, VERSION, type Job, type Operation } from './contracts';
const verifiedClient = <T>(action: (client: PoolClient) => Promise<T>) => withClient(action, { verifiedTls: true, skipSchema: true });

export type StoredJob = Job & { owner: string; input: Record<string, unknown>; input_hash: string; key: string };
/** `cache_key`/`shared` are present only on shared artifacts, so private artifact bytes are unchanged. */
export type Artifact = { schema_version: 1; id: string; owner_id: string; created_at: string; producer_version: string; kind: string; content_hash: string; data: unknown; cache_key?: string; shared?: true };
/** Owner of shared (cache-keyed, any-caller) artifacts and jobs; `@` cannot appear in an authenticated owner id. */
export const SHARED_OWNER = '@shared';
/** Per-kind artifact retention (file 11 #20); existing kinds keep report 7 d, everything else 24 h. */
const RETENTION_HOURS: Record<string, number> = { report: 168, arb_universe: 24, arb_ground_truth: 168, arb_event_dataset: 168, backrun_replay: 168 };
export const retentionHours = (kind: string) => RETENTION_HOURS[kind] ?? 24;
const retention = (kind: string) => retentionHours(kind) + ' hours';
const sharedKey = (cacheKey: string) => 'shared:' + digest.parse(cacheKey) + ':' + randomUUID();
export interface Repository {
  enqueue(owner: string, operation: Operation, input: Record<string, unknown>): Promise<Job>;
  claim(): Promise<StoredJob | null>;
  get(owner: string, id: string): Promise<Job>;
  cancel(owner: string, id: string): Promise<Job>;
  finish(id: string, result: string | { code: string; message: string; retryable: boolean }): Promise<boolean>;
  complete(job: StoredJob, kind: string, data: unknown): Promise<boolean>;
  recover(): Promise<void>;
  put(owner: string, kind: string, data: unknown): Promise<string>;
  artifact(owner: string, id: string): Promise<Artifact>;
  /** Publishes an any-caller artifact under a normalized cache key (arbCacheKey). */
  publishShared(kind: string, cacheKey: string, data: unknown): Promise<Artifact>;
  /** Latest unexpired shared artifact for (kind, cache key); private artifacts are never visible here. */
  readSharedLatest(kind: string, cacheKey: string): Promise<Artifact | null>;
  /** Returns the QUEUED/RUNNING job with this cache key, or enqueues one (atomic dedupe). */
  enqueueShared(operation: Operation, input: Record<string, unknown>, cacheKey: string): Promise<Job>;
  /** Any-caller poll of a shared (`@shared`) job by its unguessable id; private jobs are never visible here. */
  getShared(id: string): Promise<Job>;
}
/** Private paths never accept a reserved owner id (`@` prefix, e.g. `@shared`); shared paths use their own methods. */
export function privateOwner(owner: string) { if (typeof owner !== 'string' || !owner || owner.startsWith('@')) throw new ResearchError('INVALID_OWNER', 'Owner ids starting with @ are reserved.'); return owner; }
export function publicJob(job: StoredJob): Job { const { owner: _owner, input: _input, input_hash: _hash, key: _key, ...visible } = job; return visible; }

/** Fixture-only adapter: the server never selects this as a production fallback. */
export class MemoryRepository implements Repository {
  private jobs = new Map<string, StoredJob>(); private artifacts = new Map<string, Artifact>(); private expiry = new Map<string, number>(); private cacheKeys = new Map<string, string>();
  constructor(private readonly clock: () => number = Date.now) {}
  private store(artifact: Artifact) { this.artifacts.set(artifact.id, artifact); this.expiry.set(artifact.id, this.clock() + retentionHours(artifact.kind) * 3_600_000); }
  private live(id: string) { const a = this.artifacts.get(id); return a && (this.expiry.get(id) ?? 0) > this.clock() ? a : undefined; }
  async enqueue(owner: string, operation: Operation, input: Record<string, unknown>) { return this.insertJob(privateOwner(owner), operation, input); }
  private insertJob(owner: string, operation: Operation, input: Record<string, unknown>) {
    const key = String(input.idempotency_key), inputHash = hash({ operation, input, version: VERSION });
    const prior = [...this.jobs.values()].find((j) => j.owner === owner && j.key === key);
    if (prior) { if (prior.input_hash !== inputHash) return Promise.reject(new ResearchError('IDEMPOTENCY_CONFLICT', 'Idempotency key already describes different input.')); return Promise.resolve(publicJob(prior)); }
    const queued = [...this.jobs.values()].filter((j) => ['QUEUED', 'RUNNING'].includes(j.state));
    if (queued.length >= 256 || queued.filter((j) => j.owner === owner).length >= 16) return Promise.reject(new ResearchError('QUEUE_FULL', 'Research queue budget exhausted; poll existing jobs first.', true));
    const now = new Date().toISOString(); const job: StoredJob = { id: randomUUID(), owner, operation, input, input_hash: inputHash, key, state: 'QUEUED', created_at: now, updated_at: now };
    this.jobs.set(job.id, job); return Promise.resolve(publicJob(job));
  }
  async enqueueShared(operation: Operation, input: Record<string, unknown>, cacheKey: string) {
    // No await before the insert: concurrent callers in one process observe the first job.
    const active = [...this.jobs.values()].find((j) => this.cacheKeys.get(j.id) === cacheKey && ['QUEUED', 'RUNNING'].includes(j.state));
    if (active) return publicJob(active);
    const key = sharedKey(cacheKey), pending = this.insertJob(SHARED_OWNER, operation, { ...input, idempotency_key: key });
    const created = [...this.jobs.values()].find((j) => j.key === key); // inserted synchronously by enqueue
    if (created) this.cacheKeys.set(created.id, cacheKey);
    return pending;
  }
  async claim() { const j = [...this.jobs.values()].find((v) => v.state === 'QUEUED'); if (!j) return null; j.state = 'RUNNING'; return structuredClone(j); }
  private owned(owner: string, id: string) { const job = this.jobs.get(id); if (!job || job.owner !== owner) { boundaryEvent('EDGE-03', 'NOT_FOUND'); throw new ResearchError('NOT_FOUND', 'Research job not found.'); } return job; }
  async get(owner: string, id: string) { return publicJob(this.owned(privateOwner(owner), id)); }
  async getShared(id: string) { return publicJob(this.owned(SHARED_OWNER, id)); }
  async cancel(owner: string, id: string) { const j = this.owned(privateOwner(owner), id); if (['QUEUED', 'RUNNING'].includes(j.state)) j.state = 'CANCELLED'; return publicJob(j); }
  async finish(id: string, result: string | { code: string; message: string; retryable: boolean }) {
    const j = this.jobs.get(id); if (j?.state !== 'RUNNING') return false;
    j.updated_at = new Date().toISOString(); if (typeof result === 'string') { j.state = 'SUCCEEDED'; j.result_id = result; } else { j.state = 'FAILED'; j.error = result; } return true;
  }
  async complete(job: StoredJob, kind: string, data: unknown) {
    const current = this.jobs.get(job.id); if (current?.state !== 'RUNNING') { boundaryEvent('EDGE-05', 'PUBLICATION_CANCELLED'); return false; }
    const artifact = makeArtifact(job.owner, kind, data);
    this.store(artifact); current.state = 'SUCCEEDED'; current.result_id = artifact.id; current.updated_at = new Date().toISOString(); return true;
  }
  async recover() { for (const job of this.jobs.values()) if (job.state === 'RUNNING') { job.state = 'FAILED'; job.error = { code: 'WORKER_RESTARTED', message: 'Worker restarted; create a fresh job against refreshed state.', retryable: true }; } }
  async put(owner: string, kind: string, data: unknown) { const artifact = makeArtifact(privateOwner(owner), kind, data); this.store(artifact); return artifact.id; }
  async publishShared(kind: string, cacheKey: string, data: unknown) { const artifact = makeArtifact(SHARED_OWNER, kind, data, cacheKey); this.artifacts.delete(artifact.id); this.store(artifact); return structuredClone(artifact); }
  async readSharedLatest(kind: string, cacheKey: string) {
    digest.parse(cacheKey); let latest: Artifact | undefined;
    for (const a of this.artifacts.values()) if (a.shared && a.kind === kind && a.cache_key === cacheKey && this.live(a.id)) latest = a; // Map keeps insertion order; republish re-inserts
    return latest ? structuredClone(latest) : null;
  }
  async artifact(owner: string, id: string) { const a = this.live(digest.parse(id)); if (!a || a.owner_id !== owner) throw new ResearchError('NOT_FOUND', 'Research artifact not found.'); return structuredClone(a); }
}
/** Artifact identity; `cache_key` is undefined for private artifacts, so their ids are unchanged. */
const artifactId = (owner: string, kind: string, content_hash: string, version: string, cache_key?: string) => hash({ owner, kind, content_hash, version, cache_key });
function makeArtifact(owner: string, kind: string, data: unknown, cacheKey?: string): Artifact {
  const content_hash = hash(data); const id = artifactId(owner, kind, content_hash, VERSION, cacheKey);
  return { schema_version: 1, id, owner_id: owner, created_at: new Date().toISOString(), producer_version: VERSION, kind, content_hash, data, ...(cacheKey ? { cache_key: digest.parse(cacheKey), shared: true as const } : {}) };
}
export const RESEARCH_DDL = `
CREATE TABLE IF NOT EXISTS flashloan_jobs (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL, operation TEXT NOT NULL, input JSONB NOT NULL,
 input_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, state TEXT NOT NULL,
 result_id TEXT, error JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(owner_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS flashloan_jobs_queue ON flashloan_jobs(state,created_at);
CREATE TABLE IF NOT EXISTS flashloan_artifacts (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE flashloan_artifacts ADD COLUMN IF NOT EXISTS cache_key TEXT NULL, ADD COLUMN IF NOT EXISTS content_hash TEXT NULL, ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS flashloan_artifacts_shared ON flashloan_artifacts(kind,cache_key,created_at DESC);
ALTER TABLE flashloan_jobs ADD COLUMN IF NOT EXISTS cache_key TEXT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS flashloan_jobs_active_cache_key ON flashloan_jobs(cache_key) WHERE state IN ('QUEUED','RUNNING') AND cache_key IS NOT NULL;`;
export class PostgresRepository implements Repository {
  private initialized?: Promise<void>;
  constructor(private readonly root: string) {}
  private async query(sql: string, values: unknown[] = []) {
    if (!this.initialized) this.initialized = (async () => { const r = await verifiedClient(async (c) => { await c.query(RESEARCH_DDL); return true; }); if (!r) throw new ResearchError('STORAGE_UNAVAILABLE', 'Research requires a configured available PostgreSQL database.'); })();
    await this.initialized;
    const result = await verifiedClient((client) => client.query(sql, values));
    if (!result) throw new ResearchError('STORAGE_UNAVAILABLE', 'Research storage unavailable.', true);
    return result;
  }
  private row(r: Record<string, unknown>): StoredJob {
    return { id: String(r.id), owner: String(r.owner_id), operation: String(r.operation), input: r.input as Record<string, unknown>, input_hash: String(r.input_hash), key: String(r.idempotency_key), state: r.state as Job['state'], created_at: new Date(r.created_at as string).toISOString(), updated_at: new Date(r.updated_at as string).toISOString(), ...(r.result_id ? { result_id: String(r.result_id) } : {}), ...(r.error ? { error: r.error as NonNullable<Job['error']> } : {}) };
  }
  async enqueue(owner: string, operation: Operation, input: Record<string, unknown>) { return this.insertJob(privateOwner(owner), operation, input, null); }
  async enqueueShared(operation: Operation, input: Record<string, unknown>, cacheKey: string) { return this.insertJob(SHARED_OWNER, operation, { ...input, idempotency_key: sharedKey(cacheKey) }, cacheKey); }
  private async insertJob(owner: string, operation: Operation, input: Record<string, unknown>, cacheKey: string | null) {
    const inputHash = hash({ operation, input, version: VERSION });
    await this.query('SELECT 1');
    const result = await verifiedClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('hypermove.flashloan.queue'))");
        const prior = cacheKey === null ? await client.query('SELECT * FROM flashloan_jobs WHERE owner_id=$1 AND idempotency_key=$2', [owner, input.idempotency_key])
          : await client.query("SELECT * FROM flashloan_jobs WHERE cache_key=$1 AND state IN ('QUEUED','RUNNING')", [cacheKey]);
        if (prior.rows[0]) { await client.query('COMMIT'); return cacheKey === null ? prior : { rows: [{ ...prior.rows[0], shared_hit: true }] }; }
        const counts = await client.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_id=$1)::int AS owned FROM flashloan_jobs WHERE state IN ('QUEUED','RUNNING')", [owner]);
        if (counts.rows[0].total >= 256 || counts.rows[0].owned >= 16) { await client.query('ROLLBACK'); return { rows: [{ queue_full: true }] }; }
        // The partial unique index on active cache keys is the storage-level backstop for the dedupe above.
        const inserted = await client.query(`INSERT INTO flashloan_jobs(id,owner_id,operation,input,input_hash,idempotency_key,state,cache_key) VALUES($1,$2,$3,$4,$5,$6,'QUEUED',$7) RETURNING *`, [randomUUID(), owner, operation, JSON.stringify(input), inputHash, input.idempotency_key, cacheKey]);
        await client.query('COMMIT'); return inserted;
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    });
    if (!result) throw new ResearchError('STORAGE_UNAVAILABLE', 'Research queue unavailable.', true);
    if (result.rows[0]?.queue_full) throw new ResearchError('QUEUE_FULL', 'Research queue budget exhausted; poll existing jobs first.', true);
    const j = this.row(result.rows[0]); if (result.rows[0].shared_hit) return publicJob(j); if (j.input_hash !== inputHash) throw new ResearchError('IDEMPOTENCY_CONFLICT', 'Idempotency key describes different input.'); return publicJob(j);
  }
  async claim() {
    await this.query(`UPDATE flashloan_jobs SET state='FAILED',error=$1,updated_at=now() WHERE state='QUEUED' AND created_at<now()-interval '15 minutes'`, [JSON.stringify({ code: 'QUEUE_EXPIRED', message: 'Queued research expired; refresh state and start a new job.', retryable: true })]);
    const r = await this.query(`UPDATE flashloan_jobs SET state='RUNNING',updated_at=now() WHERE id=(SELECT id FROM flashloan_jobs WHERE state='QUEUED' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    return r.rows[0] ? this.row(r.rows[0]) : null;
  }
  async get(owner: string, id: string) { privateOwner(owner); const r = await this.query('SELECT * FROM flashloan_jobs WHERE id=$1 AND owner_id=$2 AND created_at>now()-interval \'7 days\'', [id, owner]); if (!r.rows[0]) { boundaryEvent('EDGE-03', 'NOT_FOUND'); throw new ResearchError('NOT_FOUND', 'Research job not found.'); } return publicJob(this.row(r.rows[0])); }
  async getShared(id: string) { const r = await this.query('SELECT * FROM flashloan_jobs WHERE id=$1 AND owner_id=$2 AND created_at>now()-interval \'7 days\'', [id, SHARED_OWNER]); if (!r.rows[0]) { boundaryEvent('EDGE-03', 'NOT_FOUND'); throw new ResearchError('NOT_FOUND', 'Research job not found.'); } return publicJob(this.row(r.rows[0])); }
  async cancel(owner: string, id: string) { privateOwner(owner); await this.query(`UPDATE flashloan_jobs SET state='CANCELLED',updated_at=now() WHERE id=$1 AND owner_id=$2 AND state IN ('QUEUED','RUNNING')`, [id, owner]); return this.get(owner, id); }
  async finish(id: string, result: string | { code: string; message: string; retryable: boolean }) { const r = await this.query(`UPDATE flashloan_jobs SET state=$2,result_id=$3,error=$4,updated_at=now() WHERE id=$1 AND state='RUNNING' RETURNING id`, [id, typeof result === 'string' ? 'SUCCEEDED' : 'FAILED', typeof result === 'string' ? result : null, typeof result === 'string' ? null : JSON.stringify(result)]); return r.rowCount === 1; }
  async recover() { await this.query(`UPDATE flashloan_jobs SET state='FAILED',error=$1,updated_at=now() WHERE state='RUNNING'`, [JSON.stringify({ code: 'WORKER_RESTARTED', message: 'Worker restarted; refresh state and create a new job.', retryable: true })]); }
  private async artifactTransaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.query('SELECT 1');
    const result = await verifiedClient(async (client) => {
      await client.query('BEGIN');
      try {
        // Publication and expiry share one lock, so GC cannot unlink a newly republished hash.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('hypermove.flashloan.artifacts'))");
        const value = await action(client); await client.query('COMMIT'); return value;
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    });
    if (result === null) throw new ResearchError('STORAGE_UNAVAILABLE', 'Artifact transaction failed.', true);
    return result;
  }
  async prune() {
    await this.artifactTransaction(async (client) => {
      const expired = await client.query('DELETE FROM flashloan_artifacts WHERE expires_at<=now() RETURNING id');
      for (const row of expired.rows) { const id = digest.parse(row.id); await unlink(join(this.root, id + '.json')).catch(() => undefined); }
      return true;
    });
    await this.query("DELETE FROM flashloan_jobs WHERE created_at<now()-interval '7 days' AND state NOT IN ('QUEUED','RUNNING')");
  }
  private async writeArtifact(owner: string, kind: string, data: unknown, cacheKey?: string) {
    const artifact = makeArtifact(owner, kind, data, cacheKey); const body = JSON.stringify(artifact);
    if (Buffer.byteLength(body) > 8_000_000) throw new ResearchError('ARTIFACT_BUDGET', 'Research artifact exceeds its byte budget.');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const destination = join(this.root, artifact.id + '.json'); const temp = join(this.root, randomUUID() + '.tmp');
    try { await writeFile(temp, body, { mode: 0o600, flag: 'wx' }); await rename(temp, destination); }
    finally { await unlink(temp).catch(() => undefined); }
    return artifact;
  }
  async complete(job: StoredJob, kind: string, data: unknown) {
    return this.artifactTransaction(async (client) => {
      const running = await client.query("SELECT id FROM flashloan_jobs WHERE id=$1 AND state='RUNNING' FOR UPDATE", [job.id]);
      if (!running.rows[0]) { boundaryEvent('EDGE-05', 'PUBLICATION_CANCELLED'); return false; }
      const artifact = await this.writeArtifact(job.owner, kind, data);
      const result = await client.query(`WITH completed AS (
      UPDATE flashloan_jobs SET state='SUCCEEDED',result_id=$2,updated_at=now() WHERE id=$1 AND state='RUNNING' RETURNING id
    ), published AS (
      INSERT INTO flashloan_artifacts(id,owner_id,kind,expires_at,content_hash) SELECT $2,$3,$4,now()+$5::interval,$6 FROM completed ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at RETURNING id
    ) SELECT id FROM completed`, [job.id, artifact.id, job.owner, kind, retention(kind), artifact.content_hash]);
      if (result.rowCount !== 1) boundaryEvent('EDGE-05', 'PUBLICATION_CANCELLED');
      return result.rowCount === 1;
    });
  }
  async put(owner: string, kind: string, data: unknown) {
    privateOwner(owner);
    return this.artifactTransaction(async (client) => {
      const artifact = await this.writeArtifact(owner, kind, data);
      await client.query(`INSERT INTO flashloan_artifacts(id,owner_id,kind,expires_at,content_hash) VALUES($1,$2,$3,now()+$4::interval,$5) ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at`, [artifact.id, owner, kind, retention(kind), artifact.content_hash]); return artifact.id;
    });
  }
  async publishShared(kind: string, cacheKey: string, data: unknown) {
    return this.artifactTransaction(async (client) => {
      const artifact = await this.writeArtifact(SHARED_OWNER, kind, data, cacheKey);
      // Republishing identical content makes it the latest again.
      await client.query(`INSERT INTO flashloan_artifacts(id,owner_id,kind,expires_at,cache_key,content_hash,shared) VALUES($1,$2,$3,now()+$4::interval,$5,$6,true) ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at,created_at=now()`, [artifact.id, SHARED_OWNER, kind, retention(kind), artifact.cache_key, artifact.content_hash]); return artifact;
    });
  }
  async readSharedLatest(kind: string, cacheKey: string) {
    digest.parse(cacheKey);
    const r = await this.query('SELECT id FROM flashloan_artifacts WHERE shared AND kind=$1 AND cache_key=$2 AND expires_at>now() ORDER BY created_at DESC LIMIT 1', [kind, cacheKey]);
    if (!r.rows[0]) return null;
    const a = await this.load(String(r.rows[0].id), SHARED_OWNER);
    if (!a.shared || a.kind !== kind || a.cache_key !== cacheKey) throw new ResearchError('ARTIFACT_CORRUPT', 'Shared artifact integrity check failed.');
    return a;
  }
  async artifact(owner: string, id: string) {
    digest.parse(id); const r = await this.query('SELECT id FROM flashloan_artifacts WHERE id=$1 AND owner_id=$2 AND expires_at>now()', [id, owner]);
    if (!r.rows[0]) throw new ResearchError('NOT_FOUND', 'Research artifact not found or expired.');
    return this.load(id, owner);
  }
  private async load(id: string, owner: string) {
    let a: Artifact; try { a = JSON.parse(await readFile(join(this.root, id + '.json'), 'utf8')); } catch { throw new ResearchError('ARTIFACT_UNAVAILABLE', 'Research artifact unavailable.'); }
    if (a.owner_id !== owner || a.id !== id || hash(a.data) !== a.content_hash || artifactId(owner, a.kind, a.content_hash, a.producer_version, a.cache_key) !== id) throw new ResearchError('ARTIFACT_CORRUPT', 'Artifact integrity check failed.');
    return a;
  }
}

/** File 11 #16: one canonical V4 Initialize record per (chain_id, manager, pool_id); inserted only after a block-hash check. */
export type V4InitEntry = { chain_id: number; manager: string; pool_id: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string; block_number: string; block_hash: string; tx_hash: string; log_index: number };
/** Contiguous block range already scanned for a manager's Initialize topic (incremental fill). */
export type V4IndexCursor = { from: string; to: string };
export interface V4InitializeIndex {
  get(chainId: number, manager: string, poolIds: string[]): Promise<Map<string, V4InitEntry>>;
  put(entries: V4InitEntry[]): Promise<void>;
  /** Drops entries found non-canonical and rewinds the cursor so the next fill rescans from that block. */
  invalidate(chainId: number, manager: string, poolIds: string[], fromBlock: bigint): Promise<void>;
  cursor(chainId: number, manager: string): Promise<V4IndexCursor | null>;
  advance(chainId: number, manager: string, cursor: V4IndexCursor): Promise<void>;
}
const indexKey = (chainId: number, manager: string, poolId?: string) => chainId + ':' + manager.toLowerCase() + (poolId === undefined ? '' : ':' + poolId.toLowerCase());
export class MemoryV4InitializeIndex implements V4InitializeIndex {
  private readonly entries = new Map<string, V4InitEntry>(); private readonly cursors = new Map<string, V4IndexCursor>();
  async get(chainId: number, manager: string, poolIds: string[]) { const out = new Map<string, V4InitEntry>(); for (const id of poolIds) { const e = this.entries.get(indexKey(chainId, manager, id)); if (e) out.set(id, structuredClone(e)); } return out; }
  async put(entries: V4InitEntry[]) { for (const e of entries) this.entries.set(indexKey(e.chain_id, e.manager, e.pool_id), structuredClone(e)); }
  async invalidate(chainId: number, manager: string, poolIds: string[], fromBlock: bigint) { for (const id of poolIds) this.entries.delete(indexKey(chainId, manager, id)); rewind(this.cursors, indexKey(chainId, manager), fromBlock); }
  async cursor(chainId: number, manager: string) { const c = this.cursors.get(indexKey(chainId, manager)); return c ? { ...c } : null; }
  async advance(chainId: number, manager: string, cursor: V4IndexCursor) { this.cursors.set(indexKey(chainId, manager), { ...cursor }); }
}
function rewind(cursors: Map<string, V4IndexCursor>, key: string, fromBlock: bigint) {
  const c = cursors.get(key); if (!c) return;
  if (fromBlock <= BigInt(c.from)) cursors.delete(key); else if (fromBlock <= BigInt(c.to)) cursors.set(key, { from: c.from, to: (fromBlock - 1n).toString() });
}
export const V4_INITIALIZE_DDL = `
CREATE TABLE IF NOT EXISTS flashloan_v4_initialize (
 chain_id INTEGER NOT NULL, manager TEXT NOT NULL, pool_id TEXT NOT NULL,
 currency0 TEXT NOT NULL, currency1 TEXT NOT NULL, fee INTEGER NOT NULL, tick_spacing INTEGER NOT NULL, hooks TEXT NOT NULL,
 block_number NUMERIC NOT NULL, block_hash TEXT NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (chain_id, manager, pool_id)
);
CREATE TABLE IF NOT EXISTS flashloan_v4_initialize_cursor (
 chain_id INTEGER NOT NULL, manager TEXT NOT NULL, scanned_from NUMERIC NOT NULL, scanned_to NUMERIC NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (chain_id, manager)
);`;
/** Postgres-backed index; additive tables only, created on first use. */
export class PostgresV4InitializeIndex implements V4InitializeIndex {
  private initialized?: Promise<void>;
  private async query(sql: string, values: unknown[] = []) {
    if (!this.initialized) this.initialized = (async () => { const r = await verifiedClient(async (c) => { await c.query(V4_INITIALIZE_DDL); return true; }); if (!r) { this.initialized = undefined; throw new ResearchError('STORAGE_UNAVAILABLE', 'V4 Initialize index requires an available PostgreSQL database.', true); } })();
    await this.initialized;
    const result = await verifiedClient((client) => client.query(sql, values));
    if (!result) throw new ResearchError('STORAGE_UNAVAILABLE', 'V4 Initialize index unavailable.', true);
    return result;
  }
  async get(chainId: number, manager: string, poolIds: string[]) {
    const out = new Map<string, V4InitEntry>(); if (!poolIds.length) return out;
    const r = await this.query('SELECT * FROM flashloan_v4_initialize WHERE chain_id=$1 AND manager=$2 AND pool_id=ANY($3::text[])', [chainId, manager.toLowerCase(), poolIds.map((p) => p.toLowerCase())]);
    for (const row of r.rows) out.set(String(row.pool_id), { chain_id: Number(row.chain_id), manager: String(row.manager), pool_id: String(row.pool_id), currency0: String(row.currency0), currency1: String(row.currency1), fee: Number(row.fee), tickSpacing: Number(row.tick_spacing), hooks: String(row.hooks), block_number: String(row.block_number), block_hash: String(row.block_hash), tx_hash: String(row.tx_hash), log_index: Number(row.log_index) });
    return out;
  }
  async put(entries: V4InitEntry[]) {
    for (const e of entries) await this.query(`INSERT INTO flashloan_v4_initialize(chain_id,manager,pool_id,currency0,currency1,fee,tick_spacing,hooks,block_number,block_hash,tx_hash,log_index) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
 ON CONFLICT(chain_id,manager,pool_id) DO UPDATE SET currency0=EXCLUDED.currency0,currency1=EXCLUDED.currency1,fee=EXCLUDED.fee,tick_spacing=EXCLUDED.tick_spacing,hooks=EXCLUDED.hooks,block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,tx_hash=EXCLUDED.tx_hash,log_index=EXCLUDED.log_index`,
      [e.chain_id, e.manager.toLowerCase(), e.pool_id.toLowerCase(), e.currency0, e.currency1, e.fee, e.tickSpacing, e.hooks, e.block_number, e.block_hash, e.tx_hash, e.log_index]);
  }
  async invalidate(chainId: number, manager: string, poolIds: string[], fromBlock: bigint) {
    const m = manager.toLowerCase();
    if (poolIds.length) await this.query('DELETE FROM flashloan_v4_initialize WHERE chain_id=$1 AND manager=$2 AND pool_id=ANY($3::text[])', [chainId, m, poolIds.map((p) => p.toLowerCase())]);
    await this.query('DELETE FROM flashloan_v4_initialize_cursor WHERE chain_id=$1 AND manager=$2 AND scanned_from>=$3', [chainId, m, fromBlock.toString()]);
    await this.query('UPDATE flashloan_v4_initialize_cursor SET scanned_to=$3::numeric-1,updated_at=now() WHERE chain_id=$1 AND manager=$2 AND scanned_to>=$3', [chainId, m, fromBlock.toString()]);
  }
  async cursor(chainId: number, manager: string) {
    const r = await this.query('SELECT scanned_from,scanned_to FROM flashloan_v4_initialize_cursor WHERE chain_id=$1 AND manager=$2', [chainId, manager.toLowerCase()]);
    return r.rows[0] ? { from: String(r.rows[0].scanned_from), to: String(r.rows[0].scanned_to) } : null;
  }
  async advance(chainId: number, manager: string, cursor: V4IndexCursor) {
    await this.query('INSERT INTO flashloan_v4_initialize_cursor(chain_id,manager,scanned_from,scanned_to) VALUES($1,$2,$3,$4) ON CONFLICT(chain_id,manager) DO UPDATE SET scanned_from=EXCLUDED.scanned_from,scanned_to=EXCLUDED.scanned_to,updated_at=now()', [chainId, manager.toLowerCase(), cursor.from, cursor.to]);
  }
}
