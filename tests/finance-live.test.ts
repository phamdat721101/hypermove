import { describe, it, expect } from 'vitest';
import { MemoryRepository } from '../src/lib/mcp/flashloan/storage';
import { FinanceService } from '../src/lib/mcp/flashloan/finance/engine';
import { RATES_CONTRACT_DIGEST } from '../src/lib/mcp/flashloan/finance/contracts';
import { ratesConfigFromEnv } from '../src/lib/mcp/flashloan/finance/rates';

/**
 * E2E-28 live read-only matrix. Requires FINANCE_LIVE=1 plus provider URLs and pins in
 * the environment (no keys). When unset this suite reports BLOCKED — never PASS.
 */
const live = process.env.FINANCE_LIVE === '1';
const endpoints = {
  arbitrum: process.env.FLASHLOAN_ARBITRUM_RPC_URL, base: process.env.FLASHLOAN_BASE_RPC_URL,
  xrpl: process.env.FLASHLOAN_XRPL_RPC_URL, flare: process.env.FINANCE_FLARE_RPC_URL,
};

describe.skipIf(!live)('E2E-28 live read-only (FINANCE_LIVE=1)', () => {
  const svc = new FinanceService({ repo: new MemoryRepository(), endpoints: Object.fromEntries(Object.entries(endpoints).filter(([, v]) => v)) as never, rates: ratesConfigFromEnv() });
  it('capabilities and lending rates read real chains with explicit missing prerequisites', async () => {
    const caps = await svc.capabilities();
    const rates = await svc.dispatch('live-owner', 'lending-rates', { schemaVersion: 'finance.rates.request/1', requestId: 'live-1', ratesContractDigest: RATES_CONTRACT_DIGEST, networks: ['arbitrum', 'base', 'flare', 'xrpl'], assets: null, side: 'both', includeDocumented: false }) as any;
    const evidence = {
      at: new Date().toISOString(), endpoints: Object.fromEntries(Object.entries(endpoints).map(([k, v]) => [k, v ? new URL(v).host : 'UNSET'])),
      capabilities: caps.map((c) => `${c.network}.${c.operation}=${c.stage}`),
      markets: rates.data.markets.map((m: any) => ({ venue: m.venue, network: m.network, asset: m.assetLabel, kind: m.rateKind, supplyApy: m.supplyApy, borrowApy: m.borrowApy, range: m.range, windowSeconds: m.window?.seconds ?? null, point: m.observation.point ?? m.observation.sourceDate })),
      missing: rates.coverage.missing,
    };
    console.log('FINANCE_LIVE_EVIDENCE ' + JSON.stringify(evidence));
    expect(rates.execution).toBe(false);
  }, 60_000);
});
describe.skipIf(live)('E2E-28 live read-only', () => {
  it('BLOCKED: FINANCE_LIVE is not set; live evidence not collected', () => { console.log('FINANCE_LIVE_BLOCKED'); expect(live).toBe(false); });
});
