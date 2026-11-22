import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import wire from '../src/lib/mcp/flashloan/finance/finance-v1.schema.json';
import rates from '../src/lib/mcp/flashloan/finance/finance-rates-v1.schema.json';
import {
  FINANCE_CONTRACT_DIGEST, PINNED_FINANCE_DIGEST, RATES_CONTRACT_DIGEST, validateFinance, validateRates, requestDigest, semanticIssues,
  normalizeEvmAddress, expm1Ray, rayToDecimal, RAY, FinanceError, type FinanceDef,
} from '../src/lib/mcp/flashloan/finance/contracts';
import { apyFromRay, aprFromRay, healthFactorDecimal, rayFromPerSecondWad, realizedRay, toAssetsDown, toAssetsUp } from '../src/lib/mcp/flashloan/finance/adapters';
import { parseXrplNumber, rippleToIso, tenthsBpsToFraction } from '../src/lib/mcp/flashloan/finance/xrpl-read';

const prd = readFileSync(resolve(process.cwd(), 'AI-FINANCE-UPGRADE-PRD.md'), 'utf8');
const prdVectors = JSON.parse(/```json finance-examples\n([\s\S]*?)\n```/.exec(prd)![1]) as Array<{ name: string; definition: FinanceDef; valid: boolean; value: unknown }>;
const D = PINNED_FINANCE_DIGEST;
const ts = '2026-11-09T10:00:00.000Z';
const evidence = [{ id: 'a'.repeat(64), contentHash: 'b'.repeat(64), expiresAt: null }];
const obs = { network: 'arbitrum', networkIdentityHash: 'c'.repeat(64), point: { kind: 'evm-block', number: '1', hash: '0x' + 'd'.repeat(64), finality: 'included' }, observedAt: ts, expiresAt: ts, consistency: 'pinned', fidelity: 'chain-read', sources: evidence };
const acct = { family: 'evm', address: '0x' + '9'.repeat(40), chainId: 42161, model: 'eoa' };
const usdc = { kind: 'erc20', network: 'arbitrum', address: '0x' + '3'.repeat(40), decimals: 6 };
const evmPosition = (over: Record<string, unknown> = {}) => ({
  kind: 'evm-collateralized', positionId: 'e'.repeat(64), account: acct, protocol: 'aave-v3', deploymentRef: 'f'.repeat(64), marketId: 'pool',
  supplied: [], shareEvidence: [], collateral: [], debt: [{ asset: usdc, quantity: { kind: 'atomic', value: '1200000000' } }],
  noDebt: false, healthFactor: '1.84', ltv: '0.4', liquidationThreshold: '0.825', observation: obs, ...over,
});

describe('finance-wire:1 contract (MC-01)', () => {
  it('digest is pinned and recomputed from the shipped schema', () => {
    expect(FINANCE_CONTRACT_DIGEST).toBe('8046b6f9d4ef51f9419481ccee4e49c567681df9fb3f48867b9194cff3de4edb');
    expect(wire.$id).toBe('urn:openx:finance-wire:1');
  });
  it.each(prdVectors.map((v) => [v.name, v] as const))('PRD vector: %s', (_name, v) => {
    expect(validateFinance(v.definition, v.value).ok).toBe(v.valid);
  });
  const extra: Array<[string, FinanceDef, boolean, unknown]> = [
    ['EvmPosition with debt', 'EvmPosition', true, evmPosition()],
    ['EvmPosition no-debt null HF', 'EvmPosition', true, evmPosition({ debt: [], noDebt: true, healthFactor: null })],
    ['EvmPosition rejects Infinity HF', 'EvmPosition', false, evmPosition({ healthFactor: 'Infinity' })],
    ['EvmPosition rejects numeric HF', 'EvmPosition', false, evmPosition({ healthFactor: 1.84 })],
    ['Amount rejects float atomic', 'Amount', false, { asset: usdc, quantity: { kind: 'atomic', value: '1.5' } }],
    ['Amount rejects JSON number', 'Amount', false, { asset: usdc, quantity: { kind: 'atomic', value: 15 } }],
    ['Coverage partial', 'Coverage', true, { complete: false, missing: [{ capability: 'robinhood.positions', reasonCode: 'ROBINHOOD_LENDER_UNVERIFIED' }], cursor: null }],
    ['Capability row', 'Capability', true, { network: 'xrpl', operation: 'flash', protocol: null, stage: 'UNSUPPORTED', authority: 'service', reasonCode: 'NO_NATIVE_FLASH_LENDER', observedAt: ts, expiresAt: ts, evidence }],
    ['Capability rejects invented stage', 'Capability', false, { network: 'xrpl', operation: 'flash', protocol: null, stage: 'ENABLED', authority: 'service', reasonCode: null, observedAt: ts, expiresAt: ts, evidence }],
    ['Job uuid', 'Job', true, { jobId: '7f9c2ba4-e88f-4d6c-9a39-6c3f0a3b8d11', state: 'QUEUED', operation: 'positions', createdAt: ts, resultRef: null, error: null }],
    ['Error', 'Error', true, { code: 'CONTRACT_MISMATCH', retryable: false, recovery: 'refresh capabilities' }],
    ['Request rejects owner field', 'Request', false, { schemaVersion: 'finance.request/1', requestId: 'r', idempotency_key: 'k', network: 'arbitrum', operation: 'capabilities', owner: 'victim' }],
    ['Request rejects legacy flash op', 'Request', false, { schemaVersion: 'finance.request/1', requestId: 'r', idempotency_key: 'k', network: 'arbitrum', operation: 'flashloan_execute', contractDigest: D }],
  ];
  it.each(extra)('extra vector: %s', (_n, def, valid, value) => { expect(validateFinance(def, value).ok).toBe(valid); });

  it('semantic rules beyond the schema', () => {
    expect(semanticIssues(evmPosition({ noDebt: true, healthFactor: '1.2' }), 'arbitrum').map((i) => i.keyword)).toContain('noDebtHealthFactor');
    expect(semanticIssues({ account: { ...acct, chainId: 8453 } }, 'arbitrum').map((i) => i.keyword)).toContain('chainMismatch');
    expect(semanticIssues({ asset: { ...usdc, network: 'base' } }, 'arbitrum').map((i) => i.keyword)).toContain('networkMismatch');
    expect(semanticIssues({ observedAt: '2026-02-30T00:00:00.000Z' }, 'arbitrum').map((i) => i.keyword)).toContain('timestamp');
    expect(semanticIssues(evmPosition(), 'arbitrum')).toEqual([]);
  });
  it('EVM addresses: checksum enforced for mixed case, lowercased for hashing', () => {
    expect(normalizeEvmAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(() => normalizeEvmAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB49'.replace('A0b', 'a0B'))).toThrow(FinanceError);
  });
  it('requestDigest is domain-separated and key-order independent', () => {
    const a = requestDigest({ b: 1, a: 'x' }), b = requestDigest({ a: 'x', b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(requestDigest({ a: 'x', b: 2 }));
  });
});

describe('finance-rates:1 contract (MC-12)', () => {
  it('is additive: copied $defs are byte-equal to finance-wire:1 and flare is rates-only', () => {
    for (const def of ['Digest', 'Uint', 'Decimal', 'Timestamp', 'EvmAddress', 'XrplAddress', 'Quantity', 'Amount', 'EvidenceRef', 'Observation', 'Coverage', 'Error'] as const) {
      expect(JSON.stringify((rates.$defs as Record<string, unknown>)[def])).toBe(JSON.stringify((wire.$defs as Record<string, unknown>)[def]));
    }
    expect(rates.$defs.Network.enum).toContain('flare');
    expect(wire.$defs.Network.enum).not.toContain('flare');
    expect(RATES_CONTRACT_DIGEST).toMatch(/^[a-f0-9]{64}$/);
  });
  const req = { schemaVersion: 'finance.rates.request/1', requestId: 'r-1', ratesContractDigest: RATES_CONTRACT_DIGEST, networks: ['xrpl', 'flare'], assets: [{ symbol: 'XRP' }], side: 'both', includeDocumented: false };
  it('accepts a valid request and rejects unknown keys, duplicates and lowercase symbols', () => {
    expect(validateRates('RatesRequest', req).ok).toBe(true);
    expect(validateRates('RatesRequest', { ...req, owner: 'x' }).ok).toBe(false);
    expect(validateRates('RatesRequest', { ...req, networks: ['xrpl', 'xrpl'] }).ok).toBe(false);
    expect(validateRates('RatesRequest', { ...req, assets: [{ symbol: 'xrp' }] }).ok).toBe(false);
    expect(validateRates('RatesRequest', { ...req, networks: ['robinhood'] }).ok).toBe(false);
  });
});

describe('MCP metadata parity: zod (SDK/tools-list) vs Ajv (truth)', () => {
  it('every Request vector gets the same verdict from the generated ZodObject', () => {
    for (const v of prdVectors.filter((x) => x.definition === 'Request')) {
      const op = (v.value as { operation?: string }).operation;
      const branch = (wire.$defs.Request.oneOf as unknown as Array<{ properties: Record<string, { const?: string }> }>).find((b) => b.properties.operation.const === op);
      if (!branch) { expect(v.valid).toBe(false); continue; }
      const zod = z.fromJSONSchema({ ...branch, $defs: wire.$defs } as never) as unknown as z.ZodType;
      expect(zod.safeParse(v.value).success, v.name).toBe(v.valid);
    }
  });
});

describe('exact rate and native unit math (golden vectors)', () => {
  const ray = (x: string) => BigInt(x) * RAY / 10000n; // basis points → ray
  it('APR/APY from ray rates (continuous compounding)', () => {
    expect(aprFromRay(ray('300'))).toBe('0.03');
    expect(apyFromRay(ray('500'))).toBe('0.051271'); // e^0.05 − 1
    expect(rayToDecimal(expm1Ray(0n))).toBe('0');
  });
  it('per-second WAD rate annualises back to APR', () => {
    const perSecond = (5n * 10n ** 16n) / 31_536_000n; // 5% APR
    expect(Number(aprFromRay(rayFromPerSecondWad(perSecond)))).toBeCloseTo(0.05, 5);
  });
  it('realised trailing yield annualises a share-price ratio', () => {
    const r = Number(rayToDecimal(realizedRay(1_010_000n, 1_000_000n, 604_800n), 6));
    expect(r).toBeCloseTo(Math.pow(1.01, 31_536_000 / 604_800) - 1, 4);
    expect(Number(rayToDecimal(realizedRay(990_000n, 1_000_000n, 604_800n), 6))).toBeLessThan(0);
  });
  it('Aave health factor sentinel is never a risk score', () => {
    expect(healthFactorDecimal((1n << 256n) - 1n)).toBeNull();
    expect(healthFactorDecimal(1_840_000_000_000_000_000n)).toBe('1.84');
  });
  it('Morpho shares use virtual shares with protocol rounding', () => {
    expect(toAssetsDown(1_000_000n, 1_000n, 1_000_000_000n)).toBe(1n);
    expect(toAssetsUp(1_000_001n, 1_000n, 1_000_000_000n)).toBe(2n);
  });
  it('XRPL: tenths of a basis point, Ripple epoch, issued decimals', () => {
    expect(tenthsBpsToFraction(500)).toBe('0.005');
    expect(rippleToIso(0)).toBe('2000-01-01T00:00:00.000Z');
    expect(parseXrplNumber('1.500e3')).toEqual({ coefficient: '15', exponent: 2 });
    expect(parseXrplNumber('0.000')).toEqual({ coefficient: '0', exponent: 0 });
    expect(parseXrplNumber('-0.0012')).toEqual({ coefficient: '-12', exponent: -4 });
    expect(() => parseXrplNumber('12345678901234567')).toThrow(FinanceError);
  });
});
