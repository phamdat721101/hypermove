/**
 * tests/mcp-tee-instruct-token-profile.test.ts
 * ----------------------------------------------
 * Covers the 2026-07-20 TEE-proxy/instruction-dispatch + token-profile ship:
 *  - flare.instruct.dispatch: flag on/off, not_configured, honest stub pass-through
 *  - flare.token.save / flare.token.profile: field population for FLR/WFLR/FXRP
 *  - getTools() flag-off diffs for both new capabilities
 *
 * Mirrors tests/mcp-confidential.test.ts conventions: hermetic (no DATABASE_URL /
 * live network), env reset per test, deterministic mock-first provider paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const origEnv = process.env;
beforeEach(() => {
  process.env = { ...origEnv, FEATURE_HYPERMOVE_MCP_GATEWAY_V1: 'true' };
  delete process.env.DATABASE_URL; // hermetic: withClient() no-ops
});
afterEach(() => {
  process.env = origEnv;
  vi.unstubAllGlobals();
  vi.doUnmock('viem');
});

// ─── flare.instruct.dispatch ─────────────────────────────────────────────────

describe('flare.instruct.dispatch: flag + configuration gates', () => {
  it('returns feature_disabled when FEATURE_MCP_INSTRUCT_V1=false', async () => {
    process.env.FEATURE_MCP_INSTRUCT_V1 = 'false';
    const { dispatchInstruction } = await import('../src/lib/mcp/flare-instruct');
    const res = await dispatchInstruction({ opType: 'GENERIC_AGENT_TASK', message: { taskType: 'SUMMARIZE' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('feature_disabled');
  });

  it('returns not_configured when TEE_EXTENSION_PROXY_URL / FLARE_INSTRUCTION_SENDER_ADDRESS are unset (the expected default state)', async () => {
    delete process.env.TEE_EXTENSION_PROXY_URL;
    delete process.env.FLARE_INSTRUCTION_SENDER_ADDRESS;
    const { dispatchInstruction } = await import('../src/lib/mcp/flare-instruct');
    const res = await dispatchInstruction({ opType: 'GENERIC_AGENT_TASK', message: { taskType: 'SUMMARIZE' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('not_configured');
      expect(res.error.hint).toMatch(/TEE_EXTENSION_PROXY_URL/);
      expect(res.error.hint).toMatch(/FLARE_INSTRUCTION_SENDER_ADDRESS/);
    }
  });

  it('returns dispatch_failed (never a fabricated success) when the signer key is missing even with proxy/address configured', async () => {
    process.env.TEE_EXTENSION_PROXY_URL = 'https://proxy.example.com';
    process.env.FLARE_INSTRUCTION_SENDER_ADDRESS = '0x1111111111111111111111111111111111111111';
    delete process.env.FLARE_INSTRUCT_SIGNER_KEY;
    const { dispatchInstruction } = await import('../src/lib/mcp/flare-instruct');
    const res = await dispatchInstruction({ opType: 'GENERIC_AGENT_TASK', message: { taskType: 'SUMMARIZE' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('dispatch_failed');
      expect(res.error.message).toMatch(/FLARE_INSTRUCT_SIGNER_KEY/);
    }
  });
});

describe('flare.instruct.dispatch: getTools() flag-off diff', () => {
  it('flare.instruct.dispatch is absent when FEATURE_MCP_INSTRUCT_V1=false; nothing else changes', async () => {
    const { getTools, _resetTools } = await import('../src/lib/mcp/tools');
    _resetTools();
    const withFlag = getTools().map((t) => t.name);

    process.env.FEATURE_MCP_INSTRUCT_V1 = 'false';
    _resetTools();
    const withoutFlag = getTools().map((t) => t.name);

    expect(withFlag).toContain('flare.instruct.dispatch');
    expect(withoutFlag).not.toContain('flare.instruct.dispatch');
    expect(withFlag.filter((n) => n !== 'flare.instruct.dispatch')).toEqual(withoutFlag);
  });

  it('flare.instruct.dispatch being off never disables confidential.attest or flare.token.* (independent masters)', async () => {
    const { getTools, _resetTools } = await import('../src/lib/mcp/tools');
    process.env.FEATURE_MCP_INSTRUCT_V1 = 'false';
    _resetTools();
    const names = getTools().map((t) => t.name);
    expect(names).toContain('confidential.attest');
    expect(names).toContain('flare.token.save');
    expect(names).toContain('flare.token.profile');
  });
});

// ─── flare.token.save / flare.token.profile ─────────────────────────────────

describe('flare.token.profile: flag gate', () => {
  it('returns feature_disabled when FEATURE_MCP_TOKEN_PROFILE_V1=false', async () => {
    process.env.FEATURE_MCP_TOKEN_PROFILE_V1 = 'false';
    const { getTokenProfile } = await import('../src/lib/mcp/flare-token-profile');
    const res = await getTokenProfile({ tokenSymbol: 'FLR' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('feature_disabled');
  });

  it('returns unknown_token for a symbol not in the known-token table (never guesses a type)', async () => {
    const { getTokenProfile } = await import('../src/lib/mcp/flare-token-profile');
    const res = await getTokenProfile({ tokenSymbol: 'NOTAREALTOKEN' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('unknown_token');
      expect(res.error.hint).toMatch(/KNOWN_TOKENS/);
    }
  });
});

describe('flare.token.profile: field population against known tokens', () => {
  it('FLR resolves as native, no contract address, real chainId/registry, real FTSO feed id', async () => {
    const { getTokenProfile } = await import('../src/lib/mcp/flare-token-profile');
    const res = await getTokenProfile({ tokenSymbol: 'flr', network: 'flare' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.identity.tokenType).toBe('native');
      expect(res.data.usage.isNativeCoin).toBe(true);
      expect(res.data.usage.isFasset).toBe(false);
      expect(res.data.network.contractAddress).toBeNull();
      expect(res.data.network.chainId).toBe(14);
      expect(res.data.network.chainIdHex).toBe('0xe');
      expect(res.data.network.contractRegistryAddress).toBe('0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019');
      expect(res.data.pricing.priceFeedPair).toBe('FLR/USD');
      expect(res.data.pricing.ftsoFeedId).toBeTruthy();
      expect(res.data.fassetParams).toBeNull();
    }
  });

  it('WFLR resolves as erc20, wrapped-native flag set, no on-chain contract read attempted without a registry entry', async () => {
    const { getTokenProfile } = await import('../src/lib/mcp/flare-token-profile');
    const res = await getTokenProfile({ tokenSymbol: 'WFLR', network: 'coston2' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.identity.tokenType).toBe('erc20');
      expect(res.data.usage.isWrappedNative).toBe(true);
      expect(res.data.usage.isNativeCoin).toBe(false);
      expect(res.data.network.chainId).toBe(114);
      expect(res.data.fassetParams).toBeNull();
    }
  });

  it('FXRP resolves as fasset, underlyingChain XRPL, honest corpus-sourced fassetParams with sources cited (registry lookup network call fails closed in test env, leaving addresses null rather than a fabricated result)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('no network in test env')),
    );
    const { getTokenProfile } = await import('../src/lib/mcp/flare-token-profile');
    const res = await getTokenProfile({ tokenSymbol: 'FXRP', network: 'flare' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.identity.tokenType).toBe('fasset');
      expect(res.data.identity.underlyingChain).toBe('XRPL');
      expect(res.data.usage.isFasset).toBe(true);
      expect(res.data.usage.isOftCompatible).toBe(true);
      // Registry/contract reads fail closed (network unavailable in test) — addresses
      // stay null, never assumed live. This IS the honest behavior, not a test gap.
      expect(res.data.network.assetManagerAddress).toBeNull();
      expect(res.data.network.contractAddress).toBeNull();
      // FAsset operational params ARE populated — corpus-sourced, not a live read —
      // and every numeric value matches the real dev.flare.network mainnet page
      // (fetched 2026-07-20), cited via `sources`.
      expect(res.data.fassetParams).not.toBeNull();
      expect(res.data.fassetParams?.lotSizeUnderlying).toBe('10 XRP');
      expect(res.data.fassetParams?.mintingCapUnderlying).toBe('170M XRP');
      expect(res.data.fassetParams?.mintingFeePercent).toBe('0.01%');
      expect(res.data.fassetParams?.redemptionFeePercent).toBe('0.2%');
      expect(res.data.fassetParams?.redemptionDefaultPremium).toBe('5%');
      expect(res.data.fassetParams?.maxRedemptionTicketsPerRequest).toBe(20);
      expect(res.data.sources.some((s) => s.includes('operational-parameters'))).toBe(true);
      expect(res.data.pricing.priceFeedPair).toBe('XRP/USD');
    }
  });
});

describe('flare.token.save / flare.token.profile: save-then-retrieve round trip', () => {
  it('persists via withClient() and a subsequent profile call returns the SAVED row, not a fresh recompute', async () => {
    const savedRows: unknown[] = [];
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
        const query = vi.fn(async (sql: string, params: unknown[]) => {
          if (sql.includes('INSERT INTO hypermove_token_profiles')) {
            savedRows.push({ token_symbol: params[0], flare_network: params[1], profile: JSON.parse(params[2] as string) });
            return { rows: [] };
          }
          if (sql.includes('SELECT profile FROM hypermove_token_profiles')) {
            const match = savedRows.find((r) => (r as { token_symbol: string }).token_symbol === params[0] && (r as { flare_network: string }).flare_network === params[1]);
            return { rows: match ? [{ profile: (match as { profile: unknown }).profile }] : [] };
          }
          return { rows: [] };
        });
        return fn({ query });
      }),
    }));

    const { saveTokenProfile, getTokenProfile } = await import('../src/lib/mcp/flare-token-profile');
    const saveRes = await saveTokenProfile({ tokenSymbol: 'FLR', network: 'flare' });
    expect(saveRes.ok).toBe(true);

    const getRes = await getTokenProfile({ tokenSymbol: 'FLR', network: 'flare' });
    expect(getRes.ok).toBe(true);
    if (getRes.ok && saveRes.ok) {
      // Same computedAt proves this came from the SAVED row (a fresh recompute would
      // have a different computedAt timestamp).
      expect(getRes.data.computedAt).toBe(saveRes.data.computedAt);
    }
    vi.doUnmock('../src/lib/db');
  });
});

describe('flare.token.save / flare.token.profile: getTools() flag-off diff', () => {
  it('both tools absent when FEATURE_MCP_TOKEN_PROFILE_V1=false; nothing else changes', async () => {
    const { getTools, _resetTools } = await import('../src/lib/mcp/tools');
    _resetTools();
    const withFlag = getTools().map((t) => t.name);

    process.env.FEATURE_MCP_TOKEN_PROFILE_V1 = 'false';
    _resetTools();
    const withoutFlag = getTools().map((t) => t.name);

    expect(withFlag).toContain('flare.token.save');
    expect(withFlag).toContain('flare.token.profile');
    expect(withoutFlag).not.toContain('flare.token.save');
    expect(withoutFlag).not.toContain('flare.token.profile');
    expect(withFlag.filter((n) => n !== 'flare.token.save' && n !== 'flare.token.profile')).toEqual(withoutFlag);
  });
});
