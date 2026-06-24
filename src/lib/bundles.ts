/**
 * src/lib/bundles.ts
 * ------------------
 * Typed accessor for /public/bundles.json. The JSON is the single source of truth
 * (also served as a machine-readable endpoint at /bundles.json for agents).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export type BundleDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface Bundle {
  id: string;
  name: string;
  tagline: string;
  description: string;
  stack: readonly string[];
  chains: readonly string[];
  protocols: readonly string[];
  default_price_micro_usdc: number;
  files: readonly string[];
  size_kb: number;
  difficulty: BundleDifficulty;
}

export interface BundleCatalog {
  version: string;
  updated_at: string;
  publisher: string;
  license: string;
  bundles: readonly Bundle[];
}

let cached: BundleCatalog | null = null;

export async function readBundles(): Promise<BundleCatalog> {
  if (cached) return cached;
  const file = path.join(process.cwd(), 'public', 'bundles.json');
  const raw = await fs.readFile(file, 'utf8');
  cached = JSON.parse(raw) as BundleCatalog;
  return cached;
}

export function bundleById(catalog: BundleCatalog, id: string): Bundle | undefined {
  return catalog.bundles.find((b) => b.id === id);
}
