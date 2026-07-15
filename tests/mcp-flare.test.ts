/**
 * tests/mcp-flare.test.ts — M2 Flare adapter (FEATURE_MCP_FLARE_V1).
 * Deterministic + offline: no live RPC (a live FTSO smoke is run separately).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deriveFeedId, FTSO_FEED_IDS } from '../src/lib/mcp/providers/chain-constants';
import { createFlare } from '../src/lib/mcp/providers/flare';
import { decide } from '../src/lib/mcp/providers/router';
import { getCatalog, _resetCatalog } from '../src/lib/mcp/catalog';

describe('M2 · Flare — feed-id derivation', () => {
  it('returns the verified BTC/USD + XRP/USD feed ids', () => {
    expect(deriveFeedId('BTC/USD')).toBe(FTSO_FEED_IDS['BTC/USD']);
    expect(deriveFeedId('XRP/USD')).toBe('0x015852502f55534400000000000000000000000000');
  });
  it('derives an arbitrary crypto feed id deterministically (category + hex + pad to 42)', () => {
    const id = deriveFeedId('FLR/USD');
    expect(id).toBe('0x01464c522f55534400000000000000000000000000');
    expect(id.length).toBe(44); // 0x + 42 hex chars = 21 bytes
  });
});

describe('M2 · Flare — routing + support', () => {
  it('routes flare / coston2 / songbird to the flare provider', () => {
    expect(decide('flareFtsoFeed', 'flare-mainnet').primary).toBe('flare');
    expect(decide('getBlock', 'coston2').primary).toBe('flare');
    expect(decide('flareFtsoFeed', 'songbird').primary).toBe('flare');
  });
  it('supports FTSO + generic reads on flare networks only', () => {
    const p = createFlare();
    expect(p.supports('flareFtsoFeed', 'flare-mainnet')).toBe(true);
    expect(p.supports('getGasPrice', 'flare-mainnet')).toBe(true);
    expect(p.supports('flareFtsoFeed', 'ethereum')).toBe(false);
  });
});

describe('M2 · Flare — honest corpus-only reads (no fabrication)', () => {
  it('returns softEmpty (never a fabricated figure) for not-yet-wired reads', async () => {
    const p = createFlare();
    const res = await p.call({ chain: 'flare-mainnet', method: 'flareFccStatus', params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('soft-empty');
  });
});

describe('M2 · Flare — catalog discoverability', () => {
  beforeEach(() => _resetCatalog());
  afterEach(() => _resetCatalog());
  it('registers flareFtsoFeed as a searchable operation', () => {
    const ids = getCatalog().map((e) => e.id);
    expect(ids).toContain('flare.flareFtsoFeed');
    expect(ids).toContain('flare.flareFassetsFxrp');
  });
});
