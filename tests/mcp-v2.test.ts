/**
 * tests/mcp-v2.test.ts
 * --------------------
 * MCP Gateway v2.0 additions: real MCP server registry, Stellar/XRPL adapters +
 * routing, data.call wiring, n-payment settlement over MCP (mock rail), and the
 * agentic meta-tools. Hermetic (no network, DB-optional).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { decide } from '@/lib/mcp/providers/router';
import { createStellar, createXrpl } from '@/lib/mcp/providers/real';
import { getCatalog, _resetCatalog } from '@/lib/mcp/catalog';
import { getTools, getTool, _resetTools } from '@/lib/mcp/tools';
import { mcpHttpHandler } from '@/lib/mcp/server';
import { insightRoadmap, ideasGenerate, skillify } from '@/lib/mcp/agentic';
import { _resetNews } from '@/lib/mcp/news';

const session = { userId: 'u1', tier: 'free' as const, kind: 'user' as const };

beforeEach(() => {
  _resetCatalog();
  _resetTools();
  _resetNews();
  delete process.env.DATABASE_URL;
  process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
  process.env.FEATURE_MCP_NEWS_V1 = 'true';
  process.env.FEATURE_MCP_AGENTIC_V1 = 'true';
});

describe('real MCP transport', () => {
  it('exposes a Streamable-HTTP handler function', () => {
    expect(typeof mcpHttpHandler()).toBe('function');
  });

  it('registry exposes v2 tools (data + payments + agentic)', () => {
    const names = getTools().map((t) => t.name);
    for (const n of ['data.call', 'payments.settle', 'payments.status', 'insight.roadmap', 'ideas.generate', 'skillify']) {
      expect(names).toContain(n);
    }
  });

  it('payments.settle + status are unmetered (no paywall deadlock)', () => {
    expect(getTool('payments.settle')!.unmetered).toBe(true);
    expect(getTool('payments.status')!.unmetered).toBe(true);
  });
});

describe('Stellar + XRPL adapters', () => {
  it('routes each chain to its adapter', () => {
    expect(decide('getAccount', 'stellar-mainnet').primary).toBe('stellar');
    expect(decide('xrplAccountInfo', 'xrpl-mainnet').primary).toBe('xrpl');
    // EVM routing unchanged
    expect(decide('getTokenBalances', 'solana-mainnet').primary).toBe('moralis');
  });

  it('providers support their canonical methods', () => {
    expect(createStellar().supports('getAccount', 'stellar-mainnet')).toBe(true);
    expect(createStellar().supports('getOrderBook', 'stellar-mainnet')).toBe(true);
    expect(createXrpl().supports('xrplBookOffers', 'xrpl-mainnet')).toBe(true);
    expect(createXrpl().supports('xrplAmmInfo', 'xrpl-mainnet')).toBe(true);
  });

  it('catalog surfaces Stellar/XRPL operations', () => {
    const ids = getCatalog().map((e) => e.id);
    expect(ids).toContain('stellar.getAccount');
    expect(ids).toContain('xrpl.xrplBookOffers');
  });
});

describe('payment settlement over MCP (mock rail)', () => {
  it('payments.settle opens a paid session via the rail', async () => {
    const out = (await getTool('payments.settle')!.handler(
      { tier: 't1_read', chain: 'base-mainnet', rail: 'x402', asset: 'USDC' },
      { session },
    )) as { ok: boolean; session?: { tier: string } };
    expect(out.ok).toBe(true);
    expect(out.session?.tier).toBe('t1_read');
  });

  it('payments.settle rejects an unknown tier', async () => {
    const out = (await getTool('payments.settle')!.handler({ tier: 'bogus', chain: 'base-mainnet' }, { session })) as { ok: boolean };
    expect(out.ok).toBe(false);
  });
});

describe('agentic meta-tools', () => {
  it('insight.roadmap grounds in news + catalog', async () => {
    const r = await insightRoadmap('Stellar');
    expect(r.project).toBe('Stellar');
    expect(r.recommendations.length).toBeGreaterThan(0);
    expect(Array.isArray(r.capabilities)).toBe(true);
  });

  it('ideas.generate returns grounded ideas', async () => {
    const r = await ideasGenerate('xrpl orderbook');
    expect(r.ideas.length).toBeGreaterThan(0);
    expect(r.ideas[0].buildsOn.length).toBeGreaterThan(0);
  });

  it('skillify codifies a task into a reusable spec', async () => {
    const r = await skillify('track Stellar DEX liquidity');
    expect(r.name.length).toBeGreaterThan(0);
    expect(r.tools).toContain('data.call');
    expect(r.steps.length).toBeGreaterThan(0);
  });
});
