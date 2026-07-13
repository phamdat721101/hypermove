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

describe('xrpl-research-pro: free to try (no entitlement gate)', () => {
  it('is listed with no requiresEntitlement and a free-to-try label', async () => {
    const { activeSkillCatalog } = await import('../src/lib/skills/catalog');
    const skill = activeSkillCatalog().find((s) => s.name === 'xrpl-research-pro')!;
    expect(skill).toBeTruthy();
    expect('requiresEntitlement' in skill).toBe(false);
    expect(skill.priceLabel).toBe('free to try');
  });

  it('runs through the harness (no 402) — skill body executes', async () => {
    const { activeSkillCatalog } = await import('../src/lib/skills/catalog');
    const { defineSkillTool } = await import('../src/lib/harness/runtime');
    const skill = activeSkillCatalog().find((s) => s.name === 'xrpl-research-pro')!;
    const tool = defineSkillTool(skill);
    const out = (await tool.handler({ query: 'x' }, { session: { userId: 'u-free' } as never })) as Record<string, unknown>;
    expect(out.status).not.toBe(402);
    expect(out.skill).toBe('xrpl-research-pro');
  });
});

describe('local-first agent-skills + honest install (nim-skill enforced)', () => {
  it('(a) no surfaced install string uses a fake npx CLI', async () => {
    const { listSkillManifests } = await import('../src/lib/skills');
    for (const m of listSkillManifests()) {
      expect(m.install).not.toMatch(/npx hypermove/);
    }
  });

  it('(b) every skill install resolves to /api/skills/<name>?format=md', async () => {
    const { listSkillManifests } = await import('../src/lib/skills');
    for (const m of listSkillManifests()) {
      expect(m.install).toContain(`/api/skills/${m.name}?format=md`);
    }
  });

  it('(c) every SKILL.md is self-contained — runs locally, no mandatory skill.<name> MCP call', async () => {
    const { SKILL_CATALOG, getSkillMd } = await import('../src/lib/skills');
    for (const s of SKILL_CATALOG) {
      const md = getSkillMd(s.name)!;
      expect(md, s.name).toContain('no MCP required');
      expect(md, s.name).toContain(`/api/skills/${s.name}?format=md`);
      // must NOT instruct calling the skill.<name> MCP execution tool
      expect(md.includes(`skill.${s.name}`), `${s.name} SKILL.md references its MCP tool`).toBe(false);
    }
  });

  it('(d) the MCP surface exposes NO skill.<name> execution tools (discovery helpers remain)', async () => {
    const { getTools } = await import('../src/lib/mcp/tools');
    const names = getTools().map((t) => t.name);
    expect(names.some((n) => n.startsWith('skill.'))).toBe(false);
    expect(names).toContain('skills.install');
  });
});
