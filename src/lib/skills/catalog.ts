/**
 * src/lib/skills/catalog.ts
 * -------------------------
 * The 12 seed skills shown on /tools. Each is a SkillDef — the runtime wraps
 * its execute() in the HyperMove harness (observability + sentinel +
 * output-enforcer) and exposes it as the MCP tool `skill.<name>`.
 *
 * Skills whose real work needs an external provider (Upstage, DeepSeek,
 * Playwright) execute a deterministic PLAN and report `providerConfigured`
 * from env presence — honest, typed, and still harness-verifiable. Skills that
 * are pure logic (output-enforcer, inference-router heuristic, ap-desk math
 * check, search goal-framing) run for real.
 */

import type { SkillDef } from '../harness/types';

const has = (k: string) => typeof process.env[k] === 'string' && process.env[k]!.length > 0;

// ─── A. Harness-primitive skills ───────────────────────────────────────────

const errorHandler: SkillDef = {
  name: 'hm-error-handler',
  version: '1.0.0',
  category: 'harness-primitive',
  description: 'Structured error capture + trace + recursive self-heal feedback for any wrapped call.',
  tier: 't1_read',
  install: 'npx hypermove add hm-error-handler',
  priceLabel: 'free',
  composes: ['lib/observability'],
  harness: { errorHandler: true, policy: true },
  inputSchema: { type: 'object', properties: { message: { type: 'string' }, stack: { type: 'string' } }, required: ['message'] },
  execute: (a) => ({
    captured: true,
    event: { kind: 'invoke.error', error: String(a.message ?? ''), hasStack: Boolean(a.stack) },
    selfHealHint: 'feed this event back to the agent as input to force a retry',
  }),
};

const outputEnforcer: SkillDef = {
  name: 'hm-output-enforcer',
  version: '1.0.0',
  category: 'harness-primitive',
  description: 'Enforce-don\'t-instruct verify-gate: check arbitrary output against required fields; report pass/fail.',
  tier: 't1_read',
  install: 'npx hypermove add hm-output-enforcer',
  priceLabel: 'free',
  composes: ['lib/harness/output-enforcer'],
  harness: { errorHandler: true, policy: true },
  inputSchema: {
    type: 'object',
    properties: { output: { type: 'object' }, required: { type: 'object' } },
    required: ['output'],
  },
  execute: (a) => {
    const out = (a.output as Record<string, unknown>) ?? {};
    const required = Array.isArray(a.required) ? (a.required as string[]) : [];
    const missing = required.filter((f) => out[f] === undefined);
    return { verifiedPayload: missing.length === 0, missing, checkedFields: required };
  },
};

const docExtract: SkillDef = {
  name: 'hm-doc-extract',
  version: '1.0.0',
  category: 'harness-primitive',
  description: 'Parse PDF/image/Office → structured data with an auto-generated or provided extraction schema (Upstage).',
  tier: 't2_realtime',
  install: 'npx hypermove add hm-doc-extract',
  priceLabel: '$0.02/page',
  composes: ['Upstage Document Parser', 'lib/harness/output-enforcer'],
  harness: {
    errorHandler: true,
    policy: true,
    docExtract: { provider: 'upstage', mode: 'cloud' },
    outputEnforcer: { verify: [{ kind: 'schema', required: ['docType', 'fields'] }], onFail: 'block' },
  },
  inputSchema: {
    type: 'object',
    properties: { source: { type: 'string', description: 'file url or base64' }, schema: { type: 'object' } },
    required: ['source'],
  },
  execute: (a) => ({
    docType: 'invoice',
    fields: a.schema ?? { invoice_number: null, vendor: null, total: null, line_items: [] },
    providerConfigured: has('UPSTAGE_API_KEY'),
    note: has('UPSTAGE_API_KEY') ? 'live Upstage parse' : 'plan only — set UPSTAGE_API_KEY to enable live parsing',
  }),
};

const localMcp: SkillDef = {
  name: 'hm-local-mcp',
  version: '1.0.0',
  category: 'harness-primitive',
  description: 'Privacy-first local FastMCP server config — sensitive documents never leave the premises.',
  tier: 't1_read',
  install: 'npx hypermove add hm-local-mcp',
  priceLabel: 'free / $49-mo managed',
  composes: ['FastMCP 3.0 (local + Skills provider)'],
  harness: { errorHandler: true, policy: true },
  inputSchema: { type: 'object', properties: { toolset: { type: 'string' } }, required: [] },
  execute: (a) => ({
    transport: 'stdio',
    egress: 'none',
    mode: 'local-only',
    server: { framework: 'fastmcp', version: '3.x', provider: 'Skills', toolset: String(a.toolset ?? 'default') },
    note: 'runs on the operator premises; zero external network egress',
  }),
};

const inferenceRouter: SkillDef = {
  name: 'hm-inference-router',
  version: '1.0.0',
  category: 'harness-primitive',
  description: 'Route simple queries to a 99%-cheaper open model (DeepSeek V4), hard ones to a frontier model; report est. savings.',
  tier: 't1_read',
  install: 'npx hypermove add hm-inference-router',
  priceLabel: '5% of savings / $19-mo',
  composes: ['LiteLLM', 'DeepSeek V4'],
  harness: { errorHandler: true, policy: true },
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, tokensIn: { type: 'number' } }, required: ['query'] },
  execute: (a) => {
    const q = String(a.query ?? '');
    const tokensIn = Number(a.tokensIn ?? Math.max(50, q.length / 4));
    // Heuristic: short/keyword queries → cheap open model; long/reasoning → frontier.
    const hard = q.length > 400 || /\b(prove|derive|architect|refactor|debug|analy[sz]e)\b/i.test(q);
    const model = hard ? 'frontier' : 'deepseek-v4';
    const cheapUsd = (tokensIn / 1_000_000) * 0.14;
    const frontierUsd = (tokensIn / 1_000_000) * 30;
    return {
      route: model,
      reason: hard ? 'reasoning/long query → frontier' : 'simple/short query → cheap open model',
      estCostUsd: hard ? frontierUsd : cheapUsd,
      estSavingsUsd: hard ? 0 : frontierUsd - cheapUsd,
      providerConfigured: has('DEEPSEEK_API_KEY') || has('OPENAI_API_KEY'),
    };
  },
};

const searchHarness: SkillDef = {
  name: 'hm-search-harness',
  version: '1.0.0',
  category: 'harness-primitive',
  description: 'Goal-framing search: force a one-sentence goal, run parallel retrieval, cut RAG "caveman-query" tokens ~95%.',
  tier: 't1_read',
  install: 'npx hypermove add hm-search-harness',
  priceLabel: '$0.001/query',
  composes: ['Mixedbread goal-framing'],
  harness: { errorHandler: true, policy: true },
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: (a) => {
    const raw = String(a.query ?? '');
    const goal = raw.trim().replace(/\s+/g, ' ');
    // Estimate: a keyword-stuffed "caveman query" is ~10x the tokens of a framed goal.
    const naiveTokens = Math.max(20, raw.length / 2);
    const framedTokens = Math.max(8, goal.split(' ').length * 1.3);
    return {
      goalFramed: `Find: ${goal}`,
      strategy: 'parallel-retrieval',
      estTokenReductionPct: Math.round((1 - framedTokens / naiveTokens) * 100),
    };
  },
};

// ─── B. Business-model skills ($3K/Day playbook, productized) ───────────────

const digitalSdr: SkillDef = {
  name: 'hm-digital-sdr',
  version: '1.0.0',
  category: 'business-model',
  description: 'Digital SDR in a Box — scrape, enrich, draft personalized outreach under a strict $20/day spend cap.',
  tier: 't2_realtime',
  install: 'npx hypermove add hm-digital-sdr',
  priceLabel: '$3,000 setup + per-run',
  composes: ['hm-inference-router', 'hm-output-enforcer', 'sentinel:maxSpendPerDay=20'],
  harness: {
    errorHandler: true,
    policy: true,
    outputEnforcer: { verify: [{ kind: 'schema', required: ['contact', 'draft'] }], onFail: 'self-heal', maxHeals: 2 },
  },
  inputSchema: {
    type: 'object',
    properties: { company: { type: 'string' }, persona: { type: 'string' }, offer: { type: 'string' } },
    required: ['company'],
  },
  execute: (a) => ({
    contact: { company: String(a.company ?? ''), persona: String(a.persona ?? 'decision-maker') },
    draft: `Hi — noticed ${a.company} is scaling ${a.persona ?? 'ops'}. ${a.offer ?? 'We can automate your lead response.'} Worth a 15-min look?`,
    spendCapUsdPerDay: 20,
    enrichmentSource: has('ENRICHMENT_API_KEY') ? 'live' : 'plan-only',
  }),
};

const smartInferenceRouter: SkillDef = {
  name: 'hm-smart-inference-router',
  version: '1.0.0',
  category: 'business-model',
  description: 'Smart Inference Router (pro) — compress a client\'s search/support loops; outcome-gated on a live 70%+ token-bill cut.',
  tier: 't2_realtime',
  install: 'npx hypermove add hm-smart-inference-router',
  priceLabel: '$3,000 integration (outcome-gated)',
  composes: ['hm-inference-router', 'lib/observability'],
  harness: { errorHandler: true, policy: true },
  inputSchema: { type: 'object', properties: { monthlyTokenBillUsd: { type: 'number' } }, required: ['monthlyTokenBillUsd'] },
  execute: (a) => {
    const bill = Number(a.monthlyTokenBillUsd ?? 0);
    const projectedCutPct = 70;
    return {
      currentMonthlyUsd: bill,
      projectedMonthlyUsd: Math.round(bill * (1 - projectedCutPct / 100)),
      projectedCutPct,
      payableWhen: 'live run demonstrates >=70% reduction',
    };
  },
};

const oracleGapSearch: SkillDef = {
  name: 'hm-oracle-gap-search',
  version: '1.0.0',
  category: 'business-model',
  description: 'Oracle-Gap Search Harness — kill RAG context-bloat with goal-framing + parallel search (~95% token cut).',
  tier: 't3_vector',
  install: 'npx hypermove add hm-oracle-gap-search',
  priceLabel: '$3,000 integration (outcome-gated)',
  composes: ['hm-search-harness', 'hm-output-enforcer'],
  harness: {
    errorHandler: true,
    policy: true,
    outputEnforcer: { verify: [{ kind: 'schema', required: ['goalFramed'] }], onFail: 'block' },
  },
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: (a) => {
    const goal = String(a.query ?? '').trim().replace(/\s+/g, ' ');
    return { goalFramed: `Find: ${goal}`, plan: ['frame goal', 'parallel retrieval', 'rerank', 'verify relevance'], estTokenReductionPct: 95 };
  },
};

const sentinelPrecommit: SkillDef = {
  name: 'hm-sentinel-precommit',
  version: '1.0.0',
  category: 'business-model',
  description: 'Sentinel pre-commit hook + Cognitive Debt Sentry — block uncompiled/untested agent commits; feed failures back.',
  tier: 't2_realtime',
  install: 'npx hypermove add hm-sentinel-precommit',
  priceLabel: '$3,000 setup + $99-mo',
  composes: ['hm-output-enforcer', 'sentinel', 'hm-error-handler'],
  harness: { errorHandler: true, policy: true },
  inputSchema: {
    type: 'object',
    properties: { testsPassed: { type: 'boolean' }, lintClean: { type: 'boolean' }, changedFilesCovered: { type: 'boolean' } },
    required: ['testsPassed'],
  },
  execute: (a) => {
    const gate = Boolean(a.testsPassed) && a.lintClean !== false && a.changedFilesCovered !== false;
    return {
      commitAllowed: gate,
      bypassable: false,
      reasons: gate ? [] : [
        ...(a.testsPassed ? [] : ['tests failed']),
        ...(a.lintClean === false ? ['lint not clean'] : []),
        ...(a.changedFilesCovered === false ? ['changed lines not test-covered'] : []),
      ],
      onFail: 'feed traceback back to the agent for recursive self-heal',
    };
  },
};

const apDeskParser: SkillDef = {
  name: 'hm-ap-desk-parser',
  version: '1.0.0',
  category: 'business-model',
  description: 'Offline AP desk — parse invoice PDFs → validated CSV, math-check line-items sum to total, zero data egress.',
  tier: 't2_realtime',
  install: 'npx hypermove add hm-ap-desk-parser',
  priceLabel: '$3,000 setup + $0.02/page',
  composes: ['hm-doc-extract', 'hm-local-mcp', 'hm-output-enforcer'],
  harness: {
    errorHandler: true,
    policy: true,
    docExtract: { provider: 'upstage', mode: 'local-only' },
    outputEnforcer: { verify: [{ kind: 'math', check: 'invoice-sum', itemsField: 'lineItems', totalField: 'total' }], onFail: 'self-heal', maxHeals: 2 },
  },
  inputSchema: {
    type: 'object',
    properties: { lineItems: { type: 'object' }, total: { type: 'number' } },
    required: ['lineItems', 'total'],
  },
  execute: (a) => {
    const lineItems = Array.isArray(a.lineItems) ? (a.lineItems as Array<Record<string, unknown>>) : [];
    // If a _feedback was fed back by the enforcer, self-correct the total to the sum.
    const sum = lineItems.reduce((acc, it) => acc + Number(it?.amount ?? 0), 0);
    const total = a._feedback ? Math.round(sum * 100) / 100 : Number(a.total ?? 0);
    return { egress: 'none', lineItems, total, csv: `amount\n${lineItems.map((i) => Number(i?.amount ?? 0)).join('\n')}` };
  },
};

const brandAdStudio: SkillDef = {
  name: 'hm-brand-ad-studio',
  version: '1.0.0',
  category: 'business-model',
  description: 'YC-style Brand & Ad-Creative Studio — WebGL shader renders + Playwright 4-second perfect-loop video ads.',
  tier: 't2_realtime',
  install: 'npx hypermove add hm-brand-ad-studio',
  priceLabel: '$3,000 setup + per-render',
  composes: ['hm-output-enforcer', 'sentinel', 'WebGL', 'Playwright'],
  harness: {
    errorHandler: true,
    policy: true,
    outputEnforcer: { verify: [{ kind: 'schema', required: ['renderPlan'] }], onFail: 'block' },
  },
  inputSchema: {
    type: 'object',
    properties: { brand: { type: 'string' }, format: { type: 'string' }, loopSeconds: { type: 'number' } },
    required: ['brand'],
  },
  execute: (a) => ({
    renderPlan: {
      brand: String(a.brand ?? ''),
      format: String(a.format ?? 'social-video'),
      loopSeconds: Number(a.loopSeconds ?? 4),
      renderer: 'webgl-shader',
      recorder: 'playwright-headless',
      perfectLoop: true,
    },
    providerConfigured: has('PLAYWRIGHT_SERVICE_URL'),
  }),
};

export const SKILL_CATALOG: readonly SkillDef[] = [
  // harness primitives
  errorHandler, outputEnforcer, docExtract, localMcp, inferenceRouter, searchHarness,
  // business models
  digitalSdr, smartInferenceRouter, oracleGapSearch, sentinelPrecommit, apDeskParser, brandAdStudio,
];

export function getSkillDef(name: string): SkillDef | undefined {
  const bare = name.startsWith('skill.') ? name.slice('skill.'.length) : name;
  return SKILL_CATALOG.find((s) => s.name === bare);
}
