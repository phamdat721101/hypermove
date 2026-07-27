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
