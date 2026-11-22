// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { Pool } from 'pg';

describe.skipIf(process.env.FLASHLOAN_POSTGRES !== '1')('real disposable PostgreSQL research persistence', () => {
  it('atomically claims, isolates, cancels, expires and republishes durable artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flashloan-pg-')); const data = join(root, 'database');
    const binaries = process.env.FLASHLOAN_POSTGRES_BIN ?? '/usr/local/opt/postgresql@15/bin';
    const execute = (binary: string, args: string[]) => { const r = spawnSync(join(binaries, binary), args, { encoding: 'utf8', timeout: 30000 }); if (r.status !== 0) throw Error(`Local ${binary} failed: ${r.stderr.slice(-2000)}`); };
    const reservation = createServer(); await new Promise<void>((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); }); const port = (reservation.address() as { port: number }).port; await new Promise<void>((done) => reservation.close(() => done()));
    let started = false; let inspection: Pool | undefined;
    try {
      execute('initdb', ['-D', data, '-A', 'trust', '-U', 'flashloan', '--no-locale']);
      execute('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${root}`, '-w', 'start']); started = true;
      const url = `postgresql://flashloan@127.0.0.1:${port}/postgres`; vi.stubEnv('DATABASE_URL', url);
      const { PostgresRepository, RESEARCH_DDL, SHARED_OWNER } = await import('../src/lib/mcp/flashloan/storage'); const repo = new PostgresRepository(join(root, 'artifacts'));
      // M5a additive migration: start from the pre-M5a tables (DDL before the first ALTER) holding a legacy row.
      inspection = new Pool({ connectionString: url }); await inspection.query(RESEARCH_DDL.slice(0, RESEARCH_DDL.indexOf('ALTER TABLE')));
      await inspection.query("INSERT INTO flashloan_artifacts(id,owner_id,kind,expires_at) VALUES($1,'alice','report',now()+interval '1 hour')", ['0'.repeat(64)]);
      const input = { idempotency_key: 'same', network: 'base', tokens: ['0x' + '1'.repeat(40)] };
      const [first, second] = await Promise.all([repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input), repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input)]); expect(first.id).toBe(second.id);
      const [claim, other] = await Promise.all([repo.claim(), repo.claim()]); const claimed = claim ?? other; expect(claimed).toBeTruthy(); expect(claim && other).toBeFalsy();
      await repo.cancel('alice', first.id); expect(await repo.complete(claimed!, 'report', { status: 'passed' })).toBe(false); expect((await repo.get('alice', first.id)).state).toBe('CANCELLED');
      const next = await repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', { ...input, idempotency_key: 'next' }); const nextClaim = await repo.claim(); expect(nextClaim!.id).toBe(next.id); expect(await repo.complete(nextClaim!, 'report', { status: 'INCONCLUSIVE' })).toBe(true);
      const done = await repo.get('alice', next.id); await expect(repo.artifact('bob', done.result_id!)).rejects.toThrow('not found');
      const legacy = await inspection.query("SELECT shared,cache_key,content_hash FROM flashloan_artifacts WHERE id=$1", ['0'.repeat(64)]); expect(legacy.rows[0]).toEqual({ shared: false, cache_key: null, content_hash: null });
      const indexes = (await inspection.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename IN ('flashloan_jobs','flashloan_artifacts')")).rows.map((r) => r.indexname + ' ' + r.indexdef).join('\n');
      expect(indexes).toMatch(/flashloan_jobs_active_cache_key CREATE UNIQUE INDEX .*\(cache_key\) WHERE/); expect(indexes).toMatch(/flashloan_artifacts_shared .*\(kind, cache_key, created_at DESC\)/);
      // Shared artifacts: latest wins, private artifacts are invisible to the shared path, per-kind retention.
      const { hash } = await import('../src/lib/mcp/flashloan/contracts'); const ck = hash('universe-key');
      await repo.publishShared('arb_universe', ck, { v: 1 }); await new Promise((r) => setTimeout(r, 5)); const shared = await repo.publishShared('arb_universe', ck, { v: 2 });
      expect((await repo.readSharedLatest('arb_universe', ck))!.data).toEqual({ v: 2 }); await repo.put('alice', 'arb_universe', { v: 3 });
      expect((await repo.readSharedLatest('arb_universe', ck))!.data).toEqual({ v: 2 }); expect(await repo.readSharedLatest('arb_universe', hash('missing'))).toBeNull();
      await expect(repo.artifact('alice', shared.id)).rejects.toThrow('not found'); expect((await repo.artifact(SHARED_OWNER, shared.id)).shared).toBe(true);
      await repo.publishShared('arb_ground_truth', ck, { g: 1 });
      const ttl = (await inspection.query("SELECT kind,round(extract(epoch FROM expires_at-created_at)/3600) AS hours,content_hash FROM flashloan_artifacts WHERE shared ORDER BY kind")).rows;
      expect(ttl.map((r) => [r.kind, Number(r.hours)])).toEqual([['arb_ground_truth', 168], ['arb_universe', 24], ['arb_universe', 24]]); expect(ttl[0].content_hash).toBe(hash({ g: 1 }));
      // Atomic dedupe: concurrent misses enqueue one job; the partial unique index rejects a second active row.
      const sharedJobs = await Promise.all(Array.from({ length: 4 }, () => repo.enqueueShared('flashloan_research_job', { operation: 'capabilities' }, ck))); expect(new Set(sharedJobs.map((j) => j.id)).size).toBe(1);
      await expect(inspection.query("INSERT INTO flashloan_jobs(id,owner_id,operation,input,input_hash,idempotency_key,state,cache_key) VALUES(gen_random_uuid(),'x','op','{}','h','k','QUEUED',$1)", [ck])).rejects.toThrow(/unique/i);
      await inspection.query("UPDATE flashloan_jobs SET state='SUCCEEDED' WHERE id=$1", [sharedJobs[0].id]); expect((await repo.enqueueShared('flashloan_research_job', { operation: 'capabilities' }, ck)).id).not.toBe(sharedJobs[0].id);
      await inspection.query("UPDATE flashloan_artifacts SET expires_at=now()-interval '1 second'");
      await expect(repo.artifact('alice', done.result_id!)).rejects.toThrow('expired');
      const again = await repo.put('alice', 'report', { status: 'INCONCLUSIVE' }); expect(again).toBe(done.result_id); expect((await repo.artifact('alice', again)).kind).toBe('report');
      await inspection.query("UPDATE flashloan_artifacts SET expires_at=now()-interval '1 second'"); await repo.prune(); await expect(repo.artifact('alice', again)).rejects.toThrow();
      console.log(JSON.stringify({ event: 'flashloan.postgres_e2e', atomic_claim: true, cancellation: true, ownership: true, expiry_republish: true, maintenance: true }));
    } finally { await inspection?.end(); const { closeResearchPool } = await import('../src/lib/db'); await closeResearchPool(); if (started) execute('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  }, 60000);
});
