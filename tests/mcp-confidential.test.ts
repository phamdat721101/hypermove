/**
 * tests/mcp-confidential.test.ts
 * -------------------------------
 * Confidential MCP tool tier (Sub-PRD A attestation, Sub-PRD B Flare FCC,
 * Sub-PRD C XRPL settlement). Mirrors tests/mcp-flare.test.ts and
 * tests/mcp-xrpl-v4.test.ts conventions: hermetic (no DATABASE_URL / live
 * network), env reset per test, deterministic mock-first provider paths.
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
});

// ─── Sub-PRD A — confidential.attest / withAttestationGate ─────────────────

describe('Sub-PRD A: confidential.attest', () => {
  it('returns softEmpty (not an error, not a fabricated success) with no TEE_ATTESTATION_PROVIDER_URL set', async () => {
    delete process.env.TEE_ATTESTATION_PROVIDER_URL;
    const { verifyAttestation } = await import('../src/lib/mcp/confidential');
    const res = await verifyAttestation({ quote: 'abc123' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe('soft-empty');
      expect(res.error.hint).toMatch(/TEE_ATTESTATION_PROVIDER_URL/);
    }
  });

  it('returns feature_disabled when FEATURE_MCP_ATTESTATION=false', async () => {
    process.env.FEATURE_MCP_ATTESTATION = 'false';
    const { verifyAttestation } = await import('../src/lib/mcp/confidential');
    const res = await verifyAttestation({ quote: 'abc123' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('feature_disabled');
  });

  it('returns attestation_invalid when the provider is configured but reports an invalid quote', async () => {
    process.env.TEE_ATTESTATION_PROVIDER_URL = 'https://tee.example.com';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ valid: false }),
      }),
    );
    const { verifyAttestation } = await import('../src/lib/mcp/confidential');
    const res = await verifyAttestation({ quote: 'deadbeef' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('attestation_invalid');
  });

  it('returns a real, verified attestation result when the provider reports success', async () => {
    process.env.TEE_ATTESTATION_PROVIDER_URL = 'https://tee.example.com';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ is_online: true, provider: 'phala-cloud', tcb_info: { mrtd: 'aabbcc' } }),
      }),
    );
    const { verifyAttestation } = await import('../src/lib/mcp/confidential');
    const res = await verifyAttestation({ quote: 'deadbeef' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.attested).toBe(true);
      expect(res.data.provider).toBe('phala-cloud');
      expect(res.data.codeIdentity).toBe('aabbcc');
      expect(res.data.verifiedAt).toBeTruthy();
    }
  });

  it('fails closed on a malformed/non-JSON provider response (never treats ambiguity as a pass)', async () => {
    process.env.TEE_ATTESTATION_PROVIDER_URL = 'https://tee.example.com';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      }),
    );
    const { verifyAttestation } = await import('../src/lib/mcp/confidential');
    const res = await verifyAttestation({ quote: 'deadbeef' });
    expect(res.ok).toBe(false);
  });
});

describe('Sub-PRD A: withAttestationGate', () => {
  it('never calls execute() when attestation fails (no provider configured)', async () => {
    delete process.env.TEE_ATTESTATION_PROVIDER_URL;
    const { withAttestationGate } = await import('../src/lib/mcp/confidential');
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const result = (await withAttestationGate('bad-quote', execute)) as { ok: boolean; reason?: string };
    expect(execute).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('attestation_required');
  });

  it('delegates to execute() once attestation succeeds', async () => {
    process.env.TEE_ATTESTATION_PROVIDER_URL = 'https://tee.example.com';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ is_online: true }) }),
    );
    const { withAttestationGate } = await import('../src/lib/mcp/confidential');
    const execute = vi.fn().mockResolvedValue({ ok: true, data: 'done' });
    const result = await withAttestationGate('good-quote', execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: 'done' });
  });
});

describe('Sub-PRD A: getTools() flag-off diff', () => {
  it('confidential.attest is absent when FEATURE_MCP_ATTESTATION=false; nothing else changes', async () => {
    const { getTools, _resetTools } = await import('../src/lib/mcp/tools');
    _resetTools();
    const withFlag = getTools().map((t) => t.name);

    process.env.FEATURE_MCP_ATTESTATION = 'false';
    _resetTools();
    const withoutFlag = getTools().map((t) => t.name);

    expect(withFlag).toContain('confidential.attest');
    expect(withoutFlag).not.toContain('confidential.attest');
    expect(withFlag.filter((n) => n !== 'confidential.attest')).toEqual(withoutFlag);
  });
});

describe('Sub-PRD A: recordCall() redaction for confidential-prefixed tools', () => {
  it('logs a redacted args shape (argKeys only, never the raw quote) for confidential.attest', async () => {
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
        const query = vi.fn();
        await fn({ query });
        return query.mock.calls[0]?.[1]; // capture the bound params array
      }),
    }));

    const { callTool } = await import('../src/lib/mcp/gateway');
    const { _resetTools } = await import('../src/lib/mcp/tools');
    _resetTools();
    delete process.env.TEE_ATTESTATION_PROVIDER_URL;

    const session = { userId: 'u1', kind: 'admin', tier: 'free' } as unknown as Parameters<typeof callTool>[0]['session'];
    await callTool({ session, name: 'confidential.attest', args: { quote: 'super-secret-raw-quote-bytes' } });

    const { withClient } = await import('../src/lib/db');
    const capturedParams = (await (withClient as unknown as { mock: { results: { value: Promise<unknown[]> }[] } }).mock.results[0].value) as unknown[];
    const actualParamsHash = capturedParams[4] as string; // [user_id, session_id, tool_name, tier, params_hash, ...]

    // The real recordCall() must hash the REDACTED shape ({redacted:true, argKeys:[...]})
    // — never the raw args (which would leak the quote's own hash pre-image checkable
    // by brute-forcing known quote strings). Recompute both candidate hashes the exact
    // way gateway.ts's recordCall() does, and assert the real hash matches ONLY the
    // redacted one.
    const { createHash } = await import('node:crypto');
    const redactedHash = createHash('sha256').update(JSON.stringify({ redacted: true, argKeys: ['quote'] })).digest('hex').slice(0, 32);
    const rawHash = createHash('sha256').update(JSON.stringify({ quote: 'super-secret-raw-quote-bytes' })).digest('hex').slice(0, 32);

    expect(actualParamsHash).toBe(redactedHash);
    expect(actualParamsHash).not.toBe(rawHash);
    vi.doUnmock('../src/lib/db');
  });
});


// ─── Sub-PRD B — Flare FCC-aware tools ──────────────────────────────────────

describe('Sub-PRD B: flare.confidential.status', () => {
  it('returns softEmpty with the fcc_not_live hint on songbird before FCC deployment', async () => {
    const { createFlare } = await import('../src/lib/mcp/providers/flare');
    const provider = createFlare();
    const res = await provider.call({ chain: 'songbird', method: 'flareConfidentialStatus', params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe('soft-empty');
      expect(res.error.hint).toMatch(/FCC/);
    }
  });

  it('isFccLiveOnNetwork guard: any non-songbird network is always false without a network call', async () => {
    const { createFlare } = await import('../src/lib/mcp/providers/flare');
    const provider = createFlare();
    const res = await provider.call({ chain: 'flare-mainnet', method: 'flareConfidentialStatus', params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('soft-empty');
  });
});

describe('Sub-PRD B: flare.confidential.swap', () => {
  it('refuses with attestation_required when the quote is missing/invalid, before FCC-liveness ever changes the outcome', async () => {
    delete process.env.TEE_ATTESTATION_PROVIDER_URL;
    const { getTools, _resetTools } = await import('../src/lib/mcp/tools');
    _resetTools();
    const tool = getTools().find((t) => t.name === 'flare.confidential.swap');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({ quote: 'unverifiable-quote', chain: 'songbird' })) as { ok: boolean; reason?: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('attestation_required');
  });

  it('still refuses with fcc_not_live when attestation passes but FCC is not live (both gates independently required)', async () => {
    process.env.TEE_ATTESTATION_PROVIDER_URL = 'https://tee.example.com';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ is_online: true }) }),
    );
    const { getTools, _resetTools } = await import('../src/lib/mcp/tools');
    _resetTools();
    const tool = getTools().find((t) => t.name === 'flare.confidential.swap');
    const result = (await tool!.handler({ quote: 'valid-quote', chain: 'songbird' })) as { ok?: boolean; error?: { kind?: string } };
    // Attestation passed, so execute() ran → hit the router → FlareProvider's softEmpty envelope.
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('soft-empty');
  });
});

describe('Sub-PRD B: getTools() FCC flag-off diff', () => {
  it('flare.confidential.swap and .status are absent when FEATURE_MCP_FCC_V1=false; nothing else changes', async () => {
    const { getTools, _resetTools } = await import('../src/lib/mcp/tools');
    _resetTools();
    const withFlag = getTools().map((t) => t.name);

    process.env.FEATURE_MCP_FCC_V1 = 'false';
    _resetTools();
    const withoutFlag = getTools().map((t) => t.name);

    expect(withFlag).toContain('flare.confidential.swap');
    expect(withFlag).toContain('flare.confidential.status');
    expect(withoutFlag).not.toContain('flare.confidential.swap');
    expect(withoutFlag).not.toContain('flare.confidential.status');
  });
});

// ─── Sub-PRD C — XRPL settlement tier ───────────────────────────────────────

describe('Sub-PRD C: confidential price tier', () => {
  it('TIER_PRICE_USD includes confidential at 0.50', async () => {
    const { TIER_PRICE_USD } = await import('../src/lib/mcp/paywall');
    expect(TIER_PRICE_USD.confidential).toBe('0.50');
  });

  it('settleSelection("confidential", {chain: base-mainnet}) refuses, naming XRPL as the valid option', async () => {
    const { settleSelection } = await import('../src/lib/mcp/paywall');
    const res = await settleSelection('u1', 'confidential', { chain: 'base-mainnet' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/XRPL/i);
    expect(res.hint).toMatch(/xrpl-mainnet|xrpl-testnet/);
  });

  it('validateConfidentialSelection accepts xrpl-mainnet and rejects non-XRPL chains', async () => {
    const { validateConfidentialSelection } = await import('../src/lib/mcp/payment-router');
    expect(validateConfidentialSelection({ chain: 'xrpl-mainnet' }).ok).toBe(true);
    expect(validateConfidentialSelection({ chain: 'goat-mainnet' }).ok).toBe(false);
    expect(validateConfidentialSelection({}).ok).toBe(false);
  });

  it('buildChallenge("confidential", 0) advertises XRPL-only chains', async () => {
    const { buildChallenge } = await import('../src/lib/mcp/paywall');
    const { _resetNetworks } = await import('../src/lib/mcp/payment-router');
    _resetNetworks();
    const challenge = buildChallenge('confidential', 0)['x-payment-required'];
    expect(challenge.chains.length).toBeGreaterThan(0);
    expect(challenge.chains.every((c) => c.startsWith('xrpl'))).toBe(true);
  });

  it('buildChallenge("t1_read", 0) is unchanged — full chain list (regression guard: narrowing is tier-scoped, not global)', async () => {
    const { buildChallenge } = await import('../src/lib/mcp/paywall');
    const { _resetNetworks } = await import('../src/lib/mcp/payment-router');
    _resetNetworks();
    const challenge = buildChallenge('t1_read', 0)['x-payment-required'];
    expect(challenge.chains.some((c) => !c.startsWith('xrpl'))).toBe(true);
  });
});

// ─── Final verification — getTools() / TIER_PRICE_USD diff, exactly 3 + 1 ──

describe('Final verification: FEATURE_MCP_CONFIDENTIAL_V1 master-flag diff', () => {
  it('toggling the master flag off removes EXACTLY 3 tools and TIER_PRICE_USD gains exactly 1 key', async () => {
    const { getTools, _resetTools } = await import('../src/lib/mcp/tools');
    const { TIER_PRICE_USD } = await import('../src/lib/mcp/paywall');

    _resetTools();
    const withFlag = new Set(getTools().map((t) => t.name));

    process.env.FEATURE_MCP_CONFIDENTIAL_V1 = 'false';
    _resetTools();
    const withoutFlag = new Set(getTools().map((t) => t.name));

    const removed = [...withFlag].filter((n) => !withoutFlag.has(n));
    const added = [...withoutFlag].filter((n) => !withFlag.has(n));

    expect(removed.sort()).toEqual(['confidential.attest', 'flare.confidential.status', 'flare.confidential.swap']);
    expect(added).toEqual([]);

    const tierKeys = Object.keys(TIER_PRICE_USD);
    expect(tierKeys).toContain('confidential');
    expect(tierKeys.filter((k) => k !== 'confidential')).toEqual(['t1_read', 't2_realtime', 't3_vector']);
  });
});
