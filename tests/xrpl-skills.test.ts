/**
 * tests/xrpl-skills.test.ts
 * -------------------------
 * Covers the XRPL builder skills end-to-end at the logic layer (no DB, no Exa
 * key — matching CI): flags, free lexical search, Exa plan-only fallback,
 * flag-gated catalog listing, 30-day entitlement, and the paid-skill 402 guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const XRPL_ENV = ['FEATURE_XRPL_DEEP_REASONING'] as const;

function clearXrplEnv() {
  for (const k of XRPL_ENV) delete process.env[k];
}

describe('platform-flag: XRPL deep-reasoning cost guard', () => {
  beforeEach(clearXrplEnv);
  afterEach(clearXrplEnv);

  it('deep-reasoning is opt-in (off by default, on when set)', async () => {
    const f = await import('../src/lib/platform-flag');
    expect(f.isXrplDeepReasoningEnabled()).toBe(false);
    process.env.FEATURE_XRPL_DEEP_REASONING = 'true';
    expect(f.isXrplDeepReasoningEnabled()).toBe(true);
  });
});

describe('xrpl-sources: free lexical search', () => {
  it('returns ranked resources for a builder query', async () => {
    const { searchXrplResources } = await import('../src/lib/mcp/xrpl-sources');
    const r = searchXrplResources({ query: 'issue MPT with clawback', limit: 8 });
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    for (const hit of r.results) {
      expect(hit.url).toMatch(/^https?:\/\//);
      expect(['docs', 'xls', 'github', 'blog', 'insights']).toContain(hit.source_type);
    }
  });

  it('filters by sourceTypes', async () => {
    const { searchXrplResources } = await import('../src/lib/mcp/xrpl-sources');
    const r = searchXrplResources({ query: 'lending vault standard', sourceTypes: ['xls'], limit: 10 });
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    expect(r.results.every((x) => x.source_type === 'xls')).toBe(true);
  });

  it('allowlist has the 7 curated domains', async () => {
    const { XRPL_ALLOWLIST } = await import('../src/lib/mcp/xrpl-sources');
    expect(XRPL_ALLOWLIST.length).toBe(7);
  });
});

describe('exa-client: plan-only without key', () => {
  it('returns schema-valid result with providerConfigured false', async () => {
    const prev = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    const { xrplResearch } = await import('../src/lib/mcp/exa-client');
    const res = await xrplResearch({ query: 'latest XRPL lending spec' });
    expect(res.providerConfigured).toBe(false);
    expect(typeof res.summary).toBe('string'); // schema: summary required
    expect(Array.isArray(res.resources)).toBe(true); // schema: resources required
    expect(res.costUsdEstimate).toBe(0);
    if (prev) process.env.EXA_API_KEY = prev;
  });
});

describe('skills catalog: XRPL skills always listed', () => {
  it('includes both XRPL skills with no flag set', async () => {
    for (const k of XRPL_ENV) delete process.env[k];
    const { activeSkillCatalog } = await import('../src/lib/skills/catalog');
    const names = activeSkillCatalog().map((s) => s.name);
    expect(names).toContain('xrpl-search');
    expect(names).toContain('xrpl-research-pro');
  });
});

describe('pro entitlement (no DB → dev semantics)', () => {
  it('buildProChallenge is a 402 RLUSD envelope', async () => {
    const { buildProChallenge } = await import('../src/lib/mcp/paywall');
    const c = await buildProChallenge('user-x');
    expect(c.status).toBe(402);
    expect(c.error).toBe('payment_required');
    expect(c.asset).toBe('RLUSD');
    expect(c.entitlement).toBe('30-day');
    // No XRPL_TREASURY_ADDRESS in CI → header is null but the envelope metadata stands.
    expect('paymentRequiredHeader' in c).toBe(true);
  });

  it('mintEntitlement returns a 30-day xrpl-pro window (synthetic without DB)', async () => {
    const { mintEntitlement } = await import('../src/lib/mcp/paywall');
    const ent = await mintEntitlement('user-1', 'rTEST', 'tx-abc');
    expect(ent.tier).toBe('xrpl-pro');
    expect(new Date(ent.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(ent.monthlyQueryCap).toBeGreaterThan(0);
  });

  it('findActiveEntitlement returns null without DB', async () => {
    const { findActiveEntitlement } = await import('../src/lib/mcp/paywall');
    expect(await findActiveEntitlement('nobody')).toBeNull();
  });
});

describe('paid-skill guard: 402 before execute', () => {
  it('xrpl-research-pro returns 402 when no entitlement (skill body never runs)', async () => {
    const { activeSkillCatalog } = await import('../src/lib/skills/catalog');
    const { defineSkillTool } = await import('../src/lib/harness/runtime');
    const skill = activeSkillCatalog().find((s) => s.name === 'xrpl-research-pro')!;
    expect(skill.requiresEntitlement).toBe('xrpl-pro');
    const tool = defineSkillTool(skill);
    const out = (await tool.handler({ query: 'x' }, { session: { userId: 'u-402' } as never })) as Record<string, unknown>;
    expect(out.status).toBe(402);
    expect(out.error).toBe('payment_required');
  });
});
