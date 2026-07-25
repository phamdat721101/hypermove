/**
 * config.ts
 * ---------
 * Env loading for the orchestrator. Fail-fast validation, never logs a secret VALUE —
 * only "present"/"missing" per key name. Per the PRD's explicit non-goal: no credential
 * this module reads is ever written to a file, log, or trace by this script.
 *
 * Loads from `.env.coston2` in this directory (gitignored) if present, then falls back
 * to process.env. Mirrors the extension-scaffold's own `.env.<chain>` convention
 * (services/tee-extension/extension-examples/extension-scaffold/.env.example) so an
 * operator who already has that file can reuse it directly.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export interface OrchestratorConfig {
  deploymentPrivateKey?: string;
  chainUrl: string;
  addressesFile: string;
  extProxyPortLocal: number;
  xrplSeed?: string;
  xrplRlusdMaxPerTransfer: string;
}

export interface ConfigCheckField {
  key: string;
  present: boolean;
  required: boolean;
}

export interface ConfigCheckResult {
  ok: boolean;
  fields: ConfigCheckField[];
  config: OrchestratorConfig;
}

/** Parses a dotenv-style file without adding a `dotenv` dependency — this file's format
 *  is simple (`KEY=value`, `#` comments, optional quotes) and this is the only place in
 *  the script that needs it. */
function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDotenvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseDotenv(readFileSync(path, 'utf8'));
}

/** Reads config from `.env.coston2` (this directory) merged with process.env —
 *  process.env wins on conflict, so a shell-exported var can always override the file. */
export function loadConfig(): ConfigCheckResult {
  const fileVars = loadDotenvFile(join(SCRIPT_DIR, '.env.coston2'));
  const merged: Record<string, string | undefined> = { ...fileVars, ...process.env };

  const config: OrchestratorConfig = {
    deploymentPrivateKey: merged.DEPLOYMENT_PRIVATE_KEY,
    chainUrl: merged.CHAIN_URL ?? 'https://coston2-api.flare.network/ext/C/rpc',
    addressesFile: merged.ADDRESSES_FILE ?? './config/coston2/deployed-addresses.json',
    extProxyPortLocal: merged.EXT_PROXY_PORT_LOCAL
      ? Number(merged.EXT_PROXY_PORT_LOCAL)
      : 6674,
    xrplSeed: merged.XRPL_SEED,
    xrplRlusdMaxPerTransfer: merged.RLUSD_MAX_PER_TRANSFER ?? '50',
  };

  const fields: ConfigCheckField[] = [
    { key: 'DEPLOYMENT_PRIVATE_KEY', present: Boolean(config.deploymentPrivateKey), required: true },
    { key: 'CHAIN_URL', present: Boolean(merged.CHAIN_URL), required: false },
    { key: 'ADDRESSES_FILE', present: Boolean(merged.ADDRESSES_FILE), required: false },
    { key: 'XRPL_SEED', present: Boolean(config.xrplSeed), required: false },
  ];

  // Only DEPLOYMENT_PRIVATE_KEY is hard-required to attempt Segment A at all.
  // XRPL_SEED absence is not fatal here — Segment C's own task can generate a
  // fresh testnet wallet via n-payment if none is supplied (see xrpl-settlement.ts).
  const ok = fields.filter((f) => f.required).every((f) => f.present);

  return { ok, fields, config };
}

/** Human-readable "what's missing" summary — never includes a value, only key names. */
export function describeMissingConfig(check: ConfigCheckResult): string {
  const missing = check.fields.filter((f) => f.required && !f.present).map((f) => f.key);
  if (missing.length === 0) return 'All required config present.';
  return `Missing required env var(s): ${missing.join(', ')}. Supply via services/tee-extension/scripts/.env.coston2 (gitignored) — never paste secret values in chat.`;
}
