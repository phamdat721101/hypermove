import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { getAddress } from 'viem';
import { canonical } from '../contracts';
import wireSchema from './finance-v1.schema.json';
import ratesSchema from './finance-rates-v1.schema.json';

/**
 * Finance contracts: finance-wire:1 (frozen, shared with the companion skill repo)
 * and the additive finance-rates:1. Ajv2020 is the single source of truth; the
 * MCP tool metadata is generated from the same JSON (see tools.ts).
 */
export const PINNED_FINANCE_DIGEST = '8046b6f9d4ef51f9419481ccee4e49c567681df9fb3f48867b9194cff3de4edb';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const FINANCE_CONTRACT_DIGEST = sha256(canonical(wireSchema));
export const RATES_CONTRACT_DIGEST = sha256(canonical(ratesSchema));
if (FINANCE_CONTRACT_DIGEST !== PINNED_FINANCE_DIGEST) throw new Error('finance-wire:1 schema drifted from the pinned contract digest');

export type FinanceDef = keyof typeof wireSchema.$defs;
export type RatesDef = keyof typeof ratesSchema.$defs;

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(wireSchema);
ajv.addSchema(ratesSchema);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

export type Issue = { path: string; keyword: string };
export type Validation<T = Record<string, unknown>> = { ok: true; value: T } | { ok: false; issues: Issue[] };

function validateRef(id: string, def: string, value: unknown): Validation {
  const key = id + '#/$defs/' + def;
  let validate = validators.get(key);
  if (!validate) { validate = ajv.compile({ $ref: key }); validators.set(key, validate); }
  if (validate(value)) return { ok: true, value: value as Record<string, unknown> };
  return { ok: false, issues: (validate.errors ?? []).slice(0, 20).map((e) => ({ path: e.instancePath || '/', keyword: e.keyword })) };
}
export const validateFinance = (def: FinanceDef, value: unknown) => validateRef(wireSchema.$id, def, value);
export const validateRates = (def: RatesDef, value: unknown) => validateRef(ratesSchema.$id, def, value);

export function requestDigest(validated: unknown): string {
  return sha256('openx/finance/request/1\n' + canonical(validated));
}

export const FINANCE_ERROR_CODES = [
  'FEATURE_DISABLED', 'CONTRACT_MISMATCH', 'INVALID_INPUT', 'AUTH_REQUIRED', 'OWNER_SCOPE_MISMATCH', 'WRONG_CHAIN',
  'UNSUPPORTED_ACCOUNT_MODEL', 'CAPABILITY_UNAVAILABLE', 'FEATURE_STATE_UNKNOWN', 'COVERAGE_INCOMPLETE', 'MISSING_BOUND',
  'POLICY_REJECTED', 'STALE_STATE', 'EXPIRED_PLAN', 'CODE_DRIFT', 'PERMISSION_MISSING', 'RESERVE_INSUFFICIENT',
  'TRUSTLINE_REQUIRED', 'DESTINATION_TAG_REQUIRED', 'SIMULATION_UNAVAILABLE', 'SIMULATION_FAILED', 'IDEMPOTENCY_CONFLICT',
  'APPROVAL_REQUIRED', 'APPROVAL_REPLAY', 'DEPENDENCY_TIMEOUT', 'SUBMISSION_UNKNOWN', 'RECONCILIATION_MISMATCH',
  'PRIVACY_BLOCKED', 'STORAGE_UNAVAILABLE', 'NOT_FOUND', 'ARCHIVE_UNAVAILABLE',
] as const;
export type FinanceErrorCode = typeof FINANCE_ERROR_CODES[number];
const RETRYABLE: ReadonlySet<FinanceErrorCode> = new Set(['DEPENDENCY_TIMEOUT', 'STORAGE_UNAVAILABLE']);

export class FinanceError extends Error {
  constructor(readonly code: FinanceErrorCode, readonly recovery: string) { super(recovery); this.name = 'FinanceError'; }
  get retryable() { return RETRYABLE.has(this.code); }
  toWire() { return { code: this.code, retryable: this.retryable, recovery: this.recovery.slice(0, 1200) }; }
}

export const CHAIN_IDS = { arbitrum: 42161, base: 8453, robinhood: 4663, flare: 14 } as const;
export type FinanceNetwork = 'arbitrum' | 'base' | 'robinhood' | 'xrpl';
export type RatesNetwork = 'arbitrum' | 'base' | 'flare' | 'xrpl';

/** EVM syntax → EIP-55 check (mixed case) → lowercase canonical form. */
export function normalizeEvmAddress(raw: string): string {
  const mixed = raw.slice(2) !== raw.slice(2).toLowerCase() && raw.slice(2) !== raw.slice(2).toUpperCase();
  const checksummed = getAddress(raw.toLowerCase());
  if (mixed && checksummed !== raw) throw new FinanceError('INVALID_INPUT', 'EVM address checksum is invalid.');
  return checksummed.toLowerCase();
}

export function isStrictTimestamp(value: string): boolean {
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString() === value;
}

/**
 * Semantic rules the schema cannot express. Returns issues (empty = accepted).
 * Applied to requests (after schema) and to every outgoing response.
 */
export function semanticIssues(value: unknown, network: string): Issue[] {
  const issues: Issue[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, path + '/' + i)); return; }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.network === 'string' && obj.network !== network) issues.push({ path: path + '/network', keyword: 'networkMismatch' });
    if (typeof obj.chainId === 'number' && network in CHAIN_IDS && CHAIN_IDS[network as keyof typeof CHAIN_IDS] !== obj.chainId) issues.push({ path: path + '/chainId', keyword: 'chainMismatch' });
    if (obj.kind === 'evm-position' || ('noDebt' in obj && 'healthFactor' in obj)) {
      if (obj.noDebt === true && obj.healthFactor !== null) issues.push({ path: path + '/healthFactor', keyword: 'noDebtHealthFactor' });
    }
    if (obj.kind === 'issued-decimal' && typeof obj.coefficient === 'string') {
      const digits = obj.coefficient.replace(/^-/, '').replace(/^0+/, '');
      if (digits.length > 16) issues.push({ path: path + '/coefficient', keyword: 'significantDigits' });
    }
    for (const [key, child] of Object.entries(obj)) {
      if (typeof child === 'string' && /At$/.test(key) && /^\d{4}-/.test(child) && !isStrictTimestamp(child)) issues.push({ path: path + '/' + key, keyword: 'timestamp' });
      if (typeof child === 'number' && !Number.isSafeInteger(child) && Number.isInteger(child)) issues.push({ path: path + '/' + key, keyword: 'unsafeInteger' });
      walk(child, path + '/' + key);
    }
  };
  walk(value, '');
  return issues.slice(0, 20);
}

/** Final gate before a response leaves the worker; a malformed success never ships. */
export function assertWireResponse(response: Record<string, unknown>, kind: 'finance' | 'rates'): void {
  const result = kind === 'finance' ? validateFinance('Response', response) : validateRates('RatesResponse', response);
  if (!result.ok) throw new Error('finance response failed contract validation at ' + result.issues[0]?.path);
  if (response.execution !== false) throw new Error('finance response must carry execution=false');
}

// ── Exact decimal helpers (bigint only, no floating point) ───────────────────
export const RAY = 10n ** 27n;
/** Fixed-point (scale 1e27) value → minimal Decimal string, truncated to `places`. */
export function rayToDecimal(value: bigint, places = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scaled = abs / 10n ** BigInt(27 - places);
  const int = scaled / 10n ** BigInt(places);
  const frac = (scaled % 10n ** BigInt(places)).toString().padStart(places, '0').replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : `${int}`;
  return negative && out !== '0' ? '-' + out : out;
}
/** e^x − 1 for x in ray (1e27) via Taylor series; |x| ≤ 5 ray. Continuous compounding = per-second limit. */
export function expm1Ray(x: bigint): bigint {
  if (x > 5n * RAY || x < -5n * RAY) throw new FinanceError('COVERAGE_INCOMPLETE', 'Rate outside supported range for APY conversion.');
  let term = x; let sum = x;
  for (let n = 2n; n < 60n && term !== 0n; n++) { term = (term * x) / (RAY * n); sum += term; }
  return sum;
}
/** (num/den)^(exp) − 1 annualisation for realised yield: exp = year/window as ray. Uses ln via series. */
export function annualiseRatio(num: bigint, den: bigint, yearOverWindowRay: bigint): bigint {
  if (num <= 0n || den <= 0n) throw new FinanceError('COVERAGE_INCOMPLETE', 'Non-positive share price.');
  const r = (num * RAY) / den; // ratio in ray
  // ln(r) = 2 * atanh((r-1)/(r+1)), converges for all r>0
  const y = ((r - RAY) * RAY) / (r + RAY);
  const y2 = (y * y) / RAY;
  let term = y; let ln = y;
  for (let k = 3n; k < 400n && term !== 0n; k += 2n) { term = (term * y2) / RAY; ln += term / k; }
  ln *= 2n;
  return expm1Ray((ln * yearOverWindowRay) / RAY);
}
