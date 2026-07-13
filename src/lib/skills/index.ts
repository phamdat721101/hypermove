/**
 * src/lib/skills/index.ts
 * -----------------------
 * Public barrel for the HyperMove /tools skill registry.
 *
 * Skills are self-contained agent-skills: they install into the agent's OWN
 * workspace (a SKILL.md saved in the host's skills dir) and run locally by
 * following their own procedure — the MCP gateway is NOT their execution host.
 * MCP is reserved for external-protocol integration (payments, live cross-chain
 * data). `defineSkillTool()` (harness/runtime) remains available as an OPTIONAL
 * adapter for anyone who also wants to expose a skill as an MCP tool.
 *
 * Exposes:
 *   • getSkillTools()  → discovery/install helper tools (skills.list / .install /
 *                        .install_prompt). They return a runnable SKILL.md; they
 *                        do NOT execute skills. HTTP /api/skills works identically.
 */

import { SKILL_CATALOG, activeSkillCatalog, getSkillDef } from './catalog';
import {
  buildInstallPrompt, installPromptsByHost, mcpConnect, fetchUrl,
  installLine, curlFallback, MCP_URL, SITE, HOST_HINTS, type Host,
} from './install-prompt';
import type { SkillDef } from '../harness/types';
import type { ToolDef } from '../mcp/tools';

function manifestOf(s: SkillDef) {
  return {
    name: s.name,
    version: s.version,
    category: s.category,
    description: s.description,
    tier: s.tier,
    price: s.priceLabel ?? null,
    composes: s.composes ?? [],
    harness: {
      errorHandler: s.harness.errorHandler !== false,
      policy: s.harness.policy !== false,
      outputEnforcer: s.harness.outputEnforcer ? s.harness.outputEnforcer.verify.map((v) => v.kind) : false,
      docExtract: s.harness.docExtract ?? false,
    },
    install: installLine(s.name),
  };
}

/** Human-readable "definition of done" from the output-enforcer verify config. */
function verifyContract(s: SkillDef): string {
  const oe = s.harness.outputEnforcer;
  if (!oe) return 'the output is present and well-formed';
  const parts = oe.verify.map((v) => {
    switch (v.kind) {
      case 'nonempty': return 'output is non-empty';
      case 'json': return 'output is valid JSON';
      case 'schema': return `output includes: ${v.required.join(', ')}`;
      case 'math': return `${v.itemsField} sums to ${v.totalField}`;
      default: return 'output is well-formed';
    }
  });
  const onFail = oe.onFail === 'self-heal'
    ? `if a check fails, feed the failure back and retry up to ${oe.maxHeals ?? 1}×, then stop`
    : 'if a check fails, block the output (do not ship it)';
  return `${parts.join('; ')} — ${onFail}`;
}

/** Only skills whose work genuinely needs live external data surface an integration note. */
function externalIntegration(s: SkillDef): string | null {
  const c = (s.composes ?? []).join(' ');
  if (/\bExa\b|exa-client/.test(c)) {
    return 'This step needs live web data — use your own web/search tool, or the HyperMove MCP tool `data.call` (external-protocol layer).';
  }
  return null;
}

/**
 * Synthesize the open-format, SELF-CONTAINED SKILL.md (Markdown + YAML
 * frontmatter). The skill installs into the agent's workspace and runs locally
 * by following the procedure below — no MCP required. MCP is referenced only as
 * an optional external-protocol integration.
 */
function skillMd(s: SkillDef): string {
  const policyStep = s.harness.policy === false ? '' : ' and apply your cost / rate / prompt-injection policy';
  const schema = s.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const argsJson = JSON.stringify(schema?.properties ?? {}, null, 2);
  const required = schema?.required?.length ? schema.required.join(', ') : 'none';
  const integration = externalIntegration(s);

  const lines: string[] = [
    '---',
    `name: ${s.name}`,
    `version: ${s.version}`,
    `description: ${s.description}`,
    'license: MIT',
    `homepage: ${SITE}`,
    `install: ${installLine(s.name)}`,
    '---',
    '',
    `# ${s.name}`,
    '',
    s.description,
    '',
    '## Run it (in your workspace — no MCP required)',
    '',
    'This is a self-contained agent-skill. Once this SKILL.md is in your skills',
    'directory it autoloads and runs locally by following the procedure below —',
    'no HyperMove server or MCP connection is needed to install or run it.',
    '',
    `**Inputs** (required: ${required}):`,
    '',
    '```json',
    argsJson,
    '```',
    '',
    '**Procedure** — apply the HyperMove harness pattern locally:',
    `1. Validate the inputs above${policyStep}.`,
    `2. Do the task: ${s.description}`,
    `3. Definition of done: ${verifyContract(s)}.`,
  ];
  if (integration) lines.push(`4. ${integration}`);
  if (s.composes?.length) lines.push('', `Composes (harness primitives you apply above): ${s.composes.join(', ')}.`);
  lines.push(
    '',
    '## External protocol (optional, via HyperMove MCP)',
    '',
    'The skill runs fully locally. Connect the HyperMove MCP only if you need the',
    'external-protocol layer — live cross-chain data (`data.call`) or to make/receive',
    'a payment (`payments.settle`, x402/mpp · USDC/RLUSD):',
    '',
    `- add MCP server \`${MCP_URL}\` (transport: http)`,
    `- Claude Code: \`${HOST_HINTS['claude-code'].mcpConnect}\``,
  );
  return lines.join('\n');
}

/** The hypermove.json harness declaration for a skill. */
function hypermoveJson(s: SkillDef) {
  return { harness: s.harness, tier: s.tier, price: s.priceLabel ?? null };
}

const skillsListTool: ToolDef = {
  name: 'skills.list',
  description: 'Browse the HyperMove skill catalog — self-contained agent-skills you install into your own workspace (they run locally; MCP is not required).',
  tier: 't1_read',
  inputSchema: { type: 'object', properties: { category: { type: 'string', description: 'harness-primitive | business-model' } } },
  handler: async (args) => {
    const cat = args.category ? String(args.category) : undefined;
    const skills = activeSkillCatalog().filter((s) => !cat || s.category === cat).map(manifestOf);
    return { count: skills.length, skills };
  },
};

const skillsInstallTool: ToolDef = {
  name: 'skills.install',
  description: 'Get the install instruction + self-contained SKILL.md for one skill (open SKILL.md format; saves into any agent host and runs locally — no MCP needed).',
  tier: 't1_read',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  handler: async (args) => {
    const s = getSkillDef(String(args.name ?? ''));
    if (!s) return { ok: false, error: 'not_found', hint: 'call skills.list to see available skills' };
    return {
      ok: true,
      // Honest, agent-native install: fetch the SKILL.md and save it locally.
      install: installLine(s.name),
      curlFallback: curlFallback(s.name),
      installPrompt: buildInstallPrompt(s),
      installPromptsByHost: installPromptsByHost(s),
      // MCP is optional — only for the external-protocol layer (payments / live data).
      mcpConnect: mcpConnect(),
      fetchUrl: fetchUrl(s.name),
      'skill.md': skillMd(s),
      'hypermove.json': hypermoveJson(s),
      addTo: ['claude-code', 'cursor', 'codex', 'opencode', 'gemini', 'windsurf', 'copilot'],
    };
  },
};

const skillsInstallPromptTool: ToolDef = {
  name: 'skills.install_prompt',
  description: 'Return ONLY the copy-paste install prompt for a skill (optionally tightened for a host). Paste it into any agent to fetch + save the SKILL.md; the skill then runs locally in the workspace — no MCP needed.',
  tier: 't1_read',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, host: { type: 'string', description: 'claude-code | cursor | codex | opencode | gemini | windsurf | copilot' } },
    required: ['name'],
  },
  handler: async (args) => {
    const s = getSkillDef(String(args.name ?? ''));
    if (!s) return { ok: false, error: 'not_found', hint: 'call skills.list to see available skills' };
    const host = args.host ? (String(args.host) as Host) : undefined;
    return { ok: true, skill: s.name, host: host ?? 'generic', prompt: buildInstallPrompt(s, host), fetchUrl: fetchUrl(s.name) };
  },
};

/**
 * Discovery/install helper tools only. Skills themselves are NOT exposed as MCP
 * execution tools — they install and run in the agent's workspace. Use
 * defineSkillTool() (harness/runtime) explicitly if you want the optional MCP
 * adapter for a specific skill.
 */
export function getSkillTools(): ToolDef[] {
  return [skillsListTool, skillsInstallTool, skillsInstallPromptTool];
}

// ─── Public helpers for the HTTP install routes (/api/skills) ──────────────

/** All skill manifests (for GET /api/skills). */
export function listSkillManifests(category?: string) {
  return activeSkillCatalog().filter((s) => !category || s.category === category).map(manifestOf);
}

/** Full install payload for one skill (for GET /api/skills/[name]). */
export function getSkillInstall(name: string) {
  const s = getSkillDef(name);
  if (!s) return null;
  return {
    ...manifestOf(s),
    curlFallback: curlFallback(s.name),
    installPrompt: buildInstallPrompt(s),
    installPromptsByHost: installPromptsByHost(s),
    mcpConnect: mcpConnect(),
    fetchUrl: fetchUrl(s.name),
    'skill.md': skillMd(s),
    'hypermove.json': hypermoveJson(s),
  };
}

/** Raw SKILL.md text for one skill (for GET /api/skills/[name]?format=md). */
export function getSkillMd(name: string): string | null {
  const s = getSkillDef(name);
  return s ? skillMd(s) : null;
}

export { SKILL_CATALOG, getSkillDef } from './catalog';
