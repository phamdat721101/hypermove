import { parentPort, workerData } from 'node:worker_threads';
import { computeInline, type ComputeTask } from '../../src/lib/mcp/flashloan/engine';

try { parentPort!.postMessage({ ok: true, data: computeInline(workerData as ComputeTask) }); }
catch { parentPort!.postMessage({ ok: false }); }
