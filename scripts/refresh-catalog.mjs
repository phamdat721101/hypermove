#!/usr/bin/env node
/**
 * scripts/refresh-catalog.mjs
 * ---------------------------
 * Deterministic catalog snapshot rebuild for the daily cron + CI drift check.
 * The catalog is TypeScript, so this re-execs itself under `tsx` (esbuild
 * resolves extensionless imports that Node's native stripping cannot).
 *
 * Usage:  npx tsx scripts/refresh-catalog.mjs      (or `pnpm mcp:refresh` for the vitest guard)
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// If we're not already under tsx, re-exec under it so TS imports resolve.
if (!process.env.__UNDER_TSX) {
  const r = spawnSync('npx', ['--yes', 'tsx', new URL(import.meta.url).pathname], {
    stdio: 'inherit',
    env: { ...process.env, __UNDER_TSX: '1' },
  });
  process.exit(r.status ?? 0);
}

async function loadCatalog() {
  const mod = await import('../src/lib/mcp/catalog.ts');
  return mod.getCatalog();
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const catalog = await loadCatalog();
const manifest = stableStringify(catalog);
const hash = createHash('sha256').update(manifest).digest('hex');

console.log(`[refresh] catalog entries: ${catalog.length}`);
console.log(`[refresh] manifest sha256: ${hash}`);

const again = createHash('sha256').update(stableStringify(await loadCatalog())).digest('hex');
if (again !== hash) {
  console.error('[refresh] NON-DETERMINISTIC catalog build — drift detected');
  process.exit(1);
}
console.log('[refresh] determinism check: OK');

