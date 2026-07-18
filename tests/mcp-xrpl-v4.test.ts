/**
 * tests/mcp-xrpl-v4.test.ts
 * -------------------------
 * MCP v4.0 "XRPL Ecosystem Native" (N1-N5): amendment gate, yield aggregator,
 * toolkit directory, hub trending, FXRP bridge status. One file for the
 * whole v4.0 package — each block is independent and can be read standalone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const origEnv = process.env;
beforeEach(() => {
  process.env = { ...origEnv };
});
afterEach(() => {
  process.env = origEnv;
});

// ─── N1 — amendment gate ────────────────────────────────────────────────────

describe('N1: xrpl.vault.info / xrpl.lending.status amendment gate', () => {
  it('xrpl.vault.info returns amendment_not_active when SingleAssetVault is not enabled', async () => {
    const { getTool } = await import('../src/lib/mcp/tools');
    const tool = getTool('xrpl.vault.info');
    expect(tool).toBeDefined();
    // Mock-mode router: providers/mock.ts's xrplAmendments fixture reports
    // SingleAssetVault as still-voting, never enabled.
    const result = (await tool!.handler({ vaultIndex: 'ABC123' })) as { ok: boolean; reason?: string; amendments?: string[] };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('amendment_not_active');
    expect(result.amendments).toContain('SingleAssetVault');
  });

  it('xrpl.lending.status returns amendment_not_active listing both required amendments', async () => {
    const { getTool } = await import('../src/lib/mcp/tools');
    const tool = getTool('xrpl.lending.status');
    const result = (await tool!.handler({ loanIndex: 'DEF456' })) as { ok: boolean; reason?: string; amendments?: string[] };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('amendment_not_active');
    expect(result.amendments).toEqual(['SingleAssetVault', 'Lending']);
  });

  it('vault/lending tools are only registered when FEATURE_MCP_XRPL_V3 is not explicitly off', async () => {
    process.env.FEATURE_MCP_XRPL_V3 = 'false';
    const { getTools } = await import('../src/lib/mcp/tools');
    const tools = getTools();
    expect(tools.find((t) => t.name === 'xrpl.vault.info')).toBeUndefined();
    expect(tools.find((t) => t.name === 'xrpl.lending.status')).toBeUndefined();
  });
});

// ─── N2 — XRPFi yield aggregator ────────────────────────────────────────────

describe('N2: xrpl.yield.compare', () => {
  it('compareYield() with no args returns all 3 venues in declared order', async () => {
    const { compareYield } = await import('../src/lib/mcp/xrpfi-sources');
    const r = compareYield();
    expect(r.venues.map((v) => v.name)).toEqual(['Soil', 'Flare (Monarq MXRPY)', 'Doppler']);
  });

  it('requireNoBridge excludes Flare-Monarq (the only bridge-required venue)', async () => {
    const { compareYield } = await import('../src/lib/mcp/xrpfi-sources');
    const r = compareYield({ requireNoBridge: true });
    expect(r.venues.map((v) => v.name)).toEqual(['Soil', 'Doppler']);
  });

  it('disclaimer is always present regardless of args (anti-fabrication guard)', async () => {
    const { compareYield } = await import('../src/lib/mcp/xrpfi-sources');
    expect(compareYield().disclaimer).toMatch(/not investment advice/i);
    expect(compareYield({ requireNoBridge: true }).disclaimer).toMatch(/not investment advice/i);
    expect(compareYield({ maxLockupDays: 1 }).disclaimer).toMatch(/not investment advice/i);
  });

  it('xrpl.yield.compare tool is registered and delegates to compareYield', async () => {
    const { getTool } = await import('../src/lib/mcp/tools');
    const tool = getTool('xrpl.yield.compare');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({ requireNoBridge: true })) as { venues: { name: string }[] };
    expect(result.venues).toHaveLength(2);
  });
});

// ─── N3 — XRPL toolkit directory ────────────────────────────────────────────

describe('N3: xrpl.toolkit.list', () => {
  it('listToolkit() with no filter returns all entries', async () => {
    const { listToolkit, XRPL_TOOLKIT } = await import('../src/lib/mcp/xrpl-toolkit');
    expect(listToolkit()).toHaveLength(XRPL_TOOLKIT.length);
  });

  it('filters by category=sdk to exactly the 2 x402-xrpl SDKs', async () => {
    const { listToolkit } = await import('../src/lib/mcp/xrpl-toolkit');
    const r = listToolkit({ category: 'sdk' });
    expect(r).toHaveLength(2);
    expect(r.every((e) => e.category === 'sdk')).toBe(true);
  });

  it('installableOnly returns only entries with a non-null install command', async () => {
    const { listToolkit } = await import('../src/lib/mcp/xrpl-toolkit');
    const r = listToolkit({ installableOnly: true });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((e) => e.install !== null)).toBe(true);
  });

  it('xrpl.toolkit.list tool is registered', async () => {
    const { getTool } = await import('../src/lib/mcp/tools');
    expect(getTool('xrpl.toolkit.list')).toBeDefined();
  });
});

// ─── N4 — XRPL AI Hub trending insight ──────────────────────────────────────

describe('N4: xrpl.hub.trending', () => {
  it('trendingSummary() narrative includes merchant count and provider names', async () => {
    const { trendingSummary } = await import('../src/lib/mcp/xrpl-hub-index');
    const { narrative, snapshot } = trendingSummary();
    expect(narrative).toContain(String(snapshot.activeMerchants));
    for (const provider of snapshot.topProviders) expect(narrative).toContain(provider);
  });

  it('xrpl.hub.trending tool composes the snapshot with a live amendment-status read', async () => {
    const { getTool } = await import('../src/lib/mcp/tools');
    const tool = getTool('xrpl.hub.trending');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({})) as { snapshot: unknown; lendingAmendmentStatus: unknown };
    expect(result.snapshot).toBeDefined();
    expect(result.lendingAmendmentStatus).toBeDefined();
  });
});

// ─── N5 — FXRP bridge status ────────────────────────────────────────────────

describe('N5: flare.fassets.bridgeStatus', () => {
  it('returns the 5-step lifecycle + adoption stat, distinct from the softEmpty flareFassetsFxrp stub', async () => {
    const { createFlare } = await import('../src/lib/mcp/providers/flare');
    const provider = createFlare();
    const result = await provider.call({ chain: 'flare-mainnet', method: 'flareFassetsBridgeStatus', params: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { lifecycle: string[]; mintedToDate: string; note: string };
      expect(data.lifecycle).toHaveLength(5);
      expect(data.mintedToDate).toMatch(/155M\+/);
      expect(data.note).toBeTruthy();
    }
  });

  it('flare.fassets.bridgeStatus tool is registered', async () => {
    const { getTool } = await import('../src/lib/mcp/tools');
    expect(getTool('flare.fassets.bridgeStatus')).toBeDefined();
  });
});
