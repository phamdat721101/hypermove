/**
 * tests/mcp-health-version.test.ts
 * ---------------------------------
 * PRD-A (2026-07-27 dream-cycle-practical-readiness-feedback): /api/mcp/health
 * gains additive `commit`/`deployed_at` fields sourced from build-time env
 * vars (GIT_SHA/DEPLOYED_AT), so an external integrator can confirm which
 * commit is actually running instead of trusting an unverifiable claim.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('PRD-A · GET /api/mcp/health reports commit + deployed_at', () => {
  it('returns commit and deployed_at from GIT_SHA/DEPLOYED_AT when set', async () => {
    process.env.GIT_SHA = 'f1202e412e3ba4555914d9e34a9b40da2ab33aef';
    process.env.DEPLOYED_AT = '2026-07-27T09:02:00Z';
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.commit).toBe('f1202e412e3ba4555914d9e34a9b40da2ab33aef');
    expect(body.deployed_at).toBe('2026-07-27T09:02:00Z');
  });

  it('falls back to null (not throwing, not a fabricated value) when GIT_SHA/DEPLOYED_AT are unset', async () => {
    delete process.env.GIT_SHA;
    delete process.env.DEPLOYED_AT;
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.commit).toBeNull();
    expect(body.deployed_at).toBeNull();
  });

  it('does not change any existing field — additive only', async () => {
    process.env.GIT_SHA = 'abc123';
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.transport).toBe('streamable-http');
    expect(body.version).toBe('2.0.0');
    expect(Array.isArray(body.tools)).toBe(true);
  });
});

// ─── Dream Cycle Confidential Extraction on Flare FCC, Task 10 ────────────

describe('Task 10 · GET /api/mcp/health surfaces registered prompts', () => {
  it('lists dream/run_confidential when the confidential + resources flags are both on', async () => {
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'true';
    process.env.FEATURE_MCP_DREAM_CONFIDENTIAL = 'true';
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as { prompts?: string[] };
    expect(body.prompts).toContain('dream/run_confidential');
  });

  it('omits dream/run_confidential when FEATURE_MCP_DREAM_CONFIDENTIAL is off (default)', async () => {
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'true';
    delete process.env.FEATURE_MCP_DREAM_CONFIDENTIAL;
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as { prompts?: string[] };
    expect(body.prompts).not.toContain('dream/run_confidential');
  });

  it('returns an empty prompts array when isMcpResourcesEnabled() is off, even if other flags are on', async () => {
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_DREAM_CONFIDENTIAL = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'false';
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as { prompts?: string[] };
    expect(body.prompts).toEqual([]);
  });

  it('returns an empty prompts array when the gateway master flag is off', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'false';
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as { prompts?: string[] };
    expect(body.prompts).toEqual([]);
  });
});

// ─── PRD 05 (2026-08-11 dream-cycle-fcc-rlusd-status-review) ────────────────

describe('PRD 05 · GET /api/mcp/health reports real_payments_configured', () => {
  it('reports true when BOTH MCP_FACILITATOR_PRIVATE_KEY and PAY_TO_ADDRESS are set', async () => {
    process.env.MCP_FACILITATOR_PRIVATE_KEY = '0xabc123';
    process.env.PAY_TO_ADDRESS = '0xdef456';
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.real_payments_configured).toBe(true);
  });

  it('reports false when MCP_FACILITATOR_PRIVATE_KEY is unset, even if PAY_TO_ADDRESS is set', async () => {
    delete process.env.MCP_FACILITATOR_PRIVATE_KEY;
    process.env.PAY_TO_ADDRESS = '0xdef456';
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.real_payments_configured).toBe(false);
  });

  it('reports false when PAY_TO_ADDRESS is unset, even if MCP_FACILITATOR_PRIVATE_KEY is set', async () => {
    process.env.MCP_FACILITATOR_PRIVATE_KEY = '0xabc123';
    delete process.env.PAY_TO_ADDRESS;
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.real_payments_configured).toBe(false);
  });

  it('reports false when both are unset (the default/mock-mode state)', async () => {
    delete process.env.MCP_FACILITATOR_PRIVATE_KEY;
    delete process.env.PAY_TO_ADDRESS;
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.real_payments_configured).toBe(false);
  });

  it('never leaks the actual key/address values — only the boolean is present', async () => {
    process.env.MCP_FACILITATOR_PRIVATE_KEY = 'super-secret-key-value';
    process.env.PAY_TO_ADDRESS = '0xSecretAddress';
    const { GET } = await import('../src/app/api/mcp/health/route');
    const res = await GET();
    const bodyText = JSON.stringify(await res.json());
    expect(bodyText).not.toContain('super-secret-key-value');
    expect(bodyText).not.toContain('0xSecretAddress');
  });

  it('flips accordingly when toggled — confirms the field reflects a LIVE read, not a cached value', async () => {
    delete process.env.MCP_FACILITATOR_PRIVATE_KEY;
    delete process.env.PAY_TO_ADDRESS;
    const { GET } = await import('../src/app/api/mcp/health/route');

    const before = (await (await GET()).json()) as Record<string, unknown>;
    expect(before.real_payments_configured).toBe(false);

    process.env.MCP_FACILITATOR_PRIVATE_KEY = '0xabc123';
    process.env.PAY_TO_ADDRESS = '0xdef456';
    const after = (await (await GET()).json()) as Record<string, unknown>;
    expect(after.real_payments_configured).toBe(true);
  });
});
