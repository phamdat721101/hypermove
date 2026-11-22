import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { ResearchError } from './contracts';
import type { ComputeAdapter } from './engine';

export const computeIsolated: ComputeAdapter = (task, signal) => new Promise((done, reject) => {
  if (signal?.aborted) { reject(new ResearchError('CANCELLED', 'Search cancelled.')); return; }
  const worker = new Worker(resolve('services/flashloan/dist/services/flashloan/compute-thread.js'), { workerData: task, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  let settled = false;
  const finish = (error?: Error, result?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); void worker.terminate().then(() => { if (error) reject(error); else done(result); }, () => reject(new ResearchError('COMPUTE_FAILED', 'Search thread did not shut down cleanly.'))); };
  const abort = () => finish(new ResearchError('CANCELLED', 'Search cancelled.'));
  const timer = setTimeout(() => finish(new ResearchError('COMPUTE_TIMEOUT', 'Search exceeded its deadline.', true)), task.kind === 'solve' && task.search?.refine ? Math.max(1, Math.min(6000, task.search.deadline_ms)) : 6000);
  signal?.addEventListener('abort', abort, { once: true });
  worker.once('message', (message) => message.ok ? finish(undefined, message.data) : finish(new ResearchError('COMPUTE_FAILED', 'Isolated search failed.')));
  worker.once('error', () => finish(new ResearchError('COMPUTE_UNAVAILABLE', 'Build the isolated compute entrypoint.')));
  worker.once('exit', () => { if (!settled) finish(new ResearchError('COMPUTE_FAILED', 'Isolated search exited without a result.')); });
});
