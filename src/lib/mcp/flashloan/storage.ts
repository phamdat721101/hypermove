import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { withClient } from '../../db';
import { hash, digest, ResearchError, boundaryEvent, VERSION, type Job, type Operation } from './contracts';
const verifiedClient = <T>(action: (client: PoolClient) => Promise<T>) => withClient(action, { verifiedTls: true, skipSchema: true });

export type StoredJob = Job & { owner: string; input: Record<string, unknown>; input_hash: string; key: string };
export type Artifact = { schema_version: 1; id: string; owner_id: string; created_at: string; producer_version: string; kind: string; content_hash: string; data: unknown };
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
}
export function publicJob(job: StoredJob): Job { const { owner: _owner, input: _input, input_hash: _hash, key: _key, ...visible } = job; return visible; }

/** Fixture-only adapter: the server never selects this as a production fallback. */
export class MemoryRepository implements Repository {
  private jobs = new Map<string, StoredJob>(); private artifacts = new Map<string, Artifact>();
  async enqueue(owner: string, operation: Operation, input: Record<string, unknown>) {
    const key = String(input.idempotency_key), inputHash = hash({ operation, input, version: VERSION });
    const prior = [...this.jobs.values()].find((j) => j.owner === owner && j.key === key);
    if (prior) { if (prior.input_hash !== inputHash) throw new ResearchError('IDEMPOTENCY_CONFLICT', 'Idempotency key already describes different input.'); return publicJob(prior); }
    const queued = [...this.jobs.values()].filter((j) => ['QUEUED', 'RUNNING'].includes(j.state));
    if (queued.length >= 256 || queued.filter((j) => j.owner === owner).length >= 16) throw new ResearchError('QUEUE_FULL', 'Research queue budget exhausted; poll existing jobs first.', true);
    const now = new Date().toISOString(); const job: StoredJob = { id: randomUUID(), owner, operation, input, input_hash: inputHash, key, state: 'QUEUED', created_at: now, updated_at: now };
    this.jobs.set(job.id, job); return publicJob(job);
  }
  async claim() { const j = [...this.jobs.values()].find((v) => v.state === 'QUEUED'); if (!j) return null; j.state = 'RUNNING'; return structuredClone(j); }
  private owned(owner: string, id: string) { const job = this.jobs.get(id); if (!job || job.owner !== owner) { boundaryEvent('EDGE-03', 'NOT_FOUND'); throw new ResearchError('NOT_FOUND', 'Research job not found.'); } return job; }
  async get(owner: string, id: string) { return publicJob(this.owned(owner, id)); }
  async cancel(owner: string, id: string) { const j = this.owned(owner, id); if (['QUEUED', 'RUNNING'].includes(j.state)) j.state = 'CANCELLED'; return publicJob(j); }
  async finish(id: string, result: string | { code: string; message: string; retryable: boolean }) {
    const j = this.jobs.get(id); if (j?.state !== 'RUNNING') return false;
    j.updated_at = new Date().toISOString(); if (typeof result === 'string') { j.state = 'SUCCEEDED'; j.result_id = result; } else { j.state = 'FAILED'; j.error = result; } return true;
  }
  async complete(job: StoredJob, kind: string, data: unknown) {
    const current = this.jobs.get(job.id); if (current?.state !== 'RUNNING') { boundaryEvent('EDGE-05', 'PUBLICATION_CANCELLED'); return false; }
    const artifact = makeArtifact(job.owner, kind, data);
    this.artifacts.set(artifact.id, artifact); current.state = 'SUCCEEDED'; current.result_id = artifact.id; current.updated_at = new Date().toISOString(); return true;
  }
  async recover() { for (const job of this.jobs.values()) if (job.state === 'RUNNING') { job.state = 'FAILED'; job.error = { code: 'WORKER_RESTARTED', message: 'Worker restarted; create a fresh job against refreshed state.', retryable: true }; } }
  async put(owner: string, kind: string, data: unknown) { const artifact = makeArtifact(owner, kind, data); this.artifacts.set(artifact.id, artifact); return artifact.id; }
  async artifact(owner: string, id: string) { const a = this.artifacts.get(digest.parse(id)); if (!a || a.owner_id !== owner) throw new ResearchError('NOT_FOUND', 'Research artifact not found.'); return structuredClone(a); }
}
function makeArtifact(owner: string, kind: string, data: unknown): Artifact {
  const content_hash = hash(data); const id = hash({ owner, kind, content_hash, version: VERSION });
  return { schema_version: 1, id, owner_id: owner, created_at: new Date().toISOString(), producer_version: VERSION, kind, content_hash, data };
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
);`;
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
  async enqueue(owner: string, operation: Operation, input: Record<string, unknown>) {
    const inputHash = hash({ operation, input, version: VERSION });
    await this.query('SELECT 1');
    const result = await verifiedClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('hypermove.flashloan.queue'))");
        const prior = await client.query('SELECT * FROM flashloan_jobs WHERE owner_id=$1 AND idempotency_key=$2', [owner, input.idempotency_key]);
        if (prior.rows[0]) { await client.query('COMMIT'); return prior; }
        const counts = await client.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_id=$1)::int AS owned FROM flashloan_jobs WHERE state IN ('QUEUED','RUNNING')", [owner]);
        if (counts.rows[0].total >= 256 || counts.rows[0].owned >= 16) { await client.query('ROLLBACK'); return { rows: [{ queue_full: true }] }; }
        const inserted = await client.query(`INSERT INTO flashloan_jobs(id,owner_id,operation,input,input_hash,idempotency_key,state) VALUES($1,$2,$3,$4,$5,$6,'QUEUED') RETURNING *`, [randomUUID(), owner, operation, JSON.stringify(input), inputHash, input.idempotency_key]);
        await client.query('COMMIT'); return inserted;
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    });
    if (!result) throw new ResearchError('STORAGE_UNAVAILABLE', 'Research queue unavailable.', true);
    if (result.rows[0]?.queue_full) throw new ResearchError('QUEUE_FULL', 'Research queue budget exhausted; poll existing jobs first.', true);
    const j = this.row(result.rows[0]); if (j.input_hash !== inputHash) throw new ResearchError('IDEMPOTENCY_CONFLICT', 'Idempotency key describes different input.'); return publicJob(j);
  }
  async claim() {
    await this.query(`UPDATE flashloan_jobs SET state='FAILED',error=$1,updated_at=now() WHERE state='QUEUED' AND created_at<now()-interval '15 minutes'`, [JSON.stringify({ code: 'QUEUE_EXPIRED', message: 'Queued research expired; refresh state and start a new job.', retryable: true })]);
    const r = await this.query(`UPDATE flashloan_jobs SET state='RUNNING',updated_at=now() WHERE id=(SELECT id FROM flashloan_jobs WHERE state='QUEUED' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    return r.rows[0] ? this.row(r.rows[0]) : null;
  }
  async get(owner: string, id: string) { const r = await this.query('SELECT * FROM flashloan_jobs WHERE id=$1 AND owner_id=$2 AND created_at>now()-interval \'7 days\'', [id, owner]); if (!r.rows[0]) { boundaryEvent('EDGE-03', 'NOT_FOUND'); throw new ResearchError('NOT_FOUND', 'Research job not found.'); } return publicJob(this.row(r.rows[0])); }
  async cancel(owner: string, id: string) { await this.query(`UPDATE flashloan_jobs SET state='CANCELLED',updated_at=now() WHERE id=$1 AND owner_id=$2 AND state IN ('QUEUED','RUNNING')`, [id, owner]); return this.get(owner, id); }
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
  private async writeArtifact(owner: string, kind: string, data: unknown) {
    const artifact = makeArtifact(owner, kind, data); const body = JSON.stringify(artifact);
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
      INSERT INTO flashloan_artifacts(id,owner_id,kind,expires_at) SELECT $2,$3,$4,now()+$5::interval FROM completed ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at RETURNING id
    ) SELECT id FROM completed`, [job.id, artifact.id, job.owner, kind, kind === 'report' ? '7 days' : '24 hours']);
      if (result.rowCount !== 1) boundaryEvent('EDGE-05', 'PUBLICATION_CANCELLED');
      return result.rowCount === 1;
    });
  }
  async put(owner: string, kind: string, data: unknown) {
    return this.artifactTransaction(async (client) => {
      const artifact = await this.writeArtifact(owner, kind, data);
      await client.query(`INSERT INTO flashloan_artifacts(id,owner_id,kind,expires_at) VALUES($1,$2,$3,now()+$4::interval) ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at`, [artifact.id, owner, kind, kind === 'report' ? '7 days' : '24 hours']); return artifact.id;
    });
  }
  async artifact(owner: string, id: string) {
    digest.parse(id); const r = await this.query('SELECT id FROM flashloan_artifacts WHERE id=$1 AND owner_id=$2 AND expires_at>now()', [id, owner]);
    if (!r.rows[0]) throw new ResearchError('NOT_FOUND', 'Research artifact not found or expired.');
    let a: Artifact; try { a = JSON.parse(await readFile(join(this.root, id + '.json'), 'utf8')); } catch { throw new ResearchError('ARTIFACT_UNAVAILABLE', 'Research artifact unavailable.'); }
    if (a.owner_id !== owner || a.id !== id || hash(a.data) !== a.content_hash || hash({ owner, kind: a.kind, content_hash: a.content_hash, version: a.producer_version }) !== id) throw new ResearchError('ARTIFACT_CORRUPT', 'Artifact integrity check failed.');
    return a;
  }
}
