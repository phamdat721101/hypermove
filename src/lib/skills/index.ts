/**
 * src/lib/skills/index.ts
 * -----------------------
 * Public barrel for the HyperMove /tools skill registry. Exposes:
 *   • getSkillTools()  → every catalog skill as a harness-wrapped MCP ToolDef
 *   • skills.list      → browse the catalog (manifests) over MCP
 *   • skills.install   → get the install command + synthesized skill.md +
 *                        hypermove.json manifest for one skill
 *
 * getTools() (mcp/tools.ts) concatenates getSkillTools() behind the
 * isMcpSkillsEnabled() flag, so every skill is automatically callable over the
 * MCP transport (the server iterates getTools()).
 */

import { defineSkillTool } from '../harness/runtime';
import { SKILL_CATALOG, getSkillDef } from './catalog';
import { buildInstallPrompt, installPromptsByHost, mcpConnect, fetchUrl, type Host } from './install-prompt';
import type { SkillDef } from '../harness/types';
import type { ToolDef } from '../mcp/tools';

function manifestOf(s: SkillDef) {
  return {
    name: s.name,
    version: s.version,
    category: s.category,
    description: s.description,
    tool: `skill.${s.name}`,
    tier: s.tier,
    price: s.priceLabel ?? null,
    composes: s.composes ?? [],
    harness: {
      errorHandler: s.harness.errorHandler !== false,
      policy: s.harness.policy !== false,
      outputEnforcer: s.harness.outputEnforcer ? s.harness.outputEnforcer.verify.map((v) => v.kind) : false,
      docExtract: s.harness.docExtract ?? false,
    },
    install: s.install,
  };
}

/** Synthesize the open-format SKILL.md (Markdown + YAML frontmatter). */
function skillMd(s: SkillDef): string {
  return [
    '---',
    `name: ${s.name}`,
    `version: ${s.version}`,
    `description: ${s.description}`,
    `install: ${s.install}`,
    '---',
    '',
    `# ${s.name}`,
    '',
    s.description,
    '',
    `Runs inside the HyperMove harness (MCP tool \`skill.${s.name}\`): observability error-capture${s.harness.policy === false ? '' : ' + sentinel policy'}${s.harness.outputEnforcer ? ' + output-enforcement' : ''}.`,
    s.composes?.length ? `\nComposes: ${s.composes.join(', ')}.` : '',
  ].join('\n');
}

/** The hypermove.json harness declaration for a skill. */
function hypermoveJson(s: SkillDef) {
  return { harness: s.harness, tier: s.tier, tool: `skill.${s.name}`, price: s.priceLabel ?? null };
}

const skillsListTool: ToolDef = {
  name: 'skills.list',
  description: 'Browse the HyperMove /tools skill catalog — harness-wrapped agent-skills you can install and call over MCP.',
  tier: 't1_read',
  inputSchema: { type: 'object', properties: { category: { type: 'string', description: 'harness-primitive | business-model' } } },
  handler: async (args) => {
    const cat = args.category ? String(args.category) : undefined;
    const skills = SKILL_CATALOG.filter((s) => !cat || s.category === cat).map(manifestOf);
    return { count: skills.length, skills };
  },
};

const skillsInstallTool: ToolDef = {
  name: 'skills.install',
  description: 'Get the install command + SKILL.md + hypermove.json manifest for one skill (open skill.md format; installs into any of 20+ agents).',
  tier: 't1_read',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  handler: async (args) => {
    const s = getSkillDef(String(args.name ?? ''));
    if (!s) return { ok: false, error: 'not_found', hint: 'call skills.list to see available skills' };
    return {
      ok: true,
      install: s.install,
      tool: `skill.${s.name}`,
      // Copy-paste install prompt (PRD-I1): one paste wires BOTH the autoloading
      // SKILL.md and the harnessed MCP tool skill.<name>.
      installPrompt: buildInstallPrompt(s),
      installPromptsByHost: installPromptsByHost(s),
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
  description: 'Return ONLY the copy-paste install prompt for a skill (optionally tightened for a host). Paste it into any agent to self-install: it wires the autoloading SKILL.md + the harnessed MCP tool skill.<name>.',
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

/** Every catalog skill as a harness-wrapped MCP tool + the registry tools. */
export function getSkillTools(): ToolDef[] {
  return [skillsListTool, skillsInstallTool, skillsInstallPromptTool, ...SKILL_CATALOG.map(defineSkillTool)];
}

// ─── Public helpers for the HTTP install routes (/api/skills) ──────────────

/** All skill manifests (for GET /api/skills). */
export function listSkillManifests(category?: string) {
  return SKILL_CATALOG.filter((s) => !category || s.category === category).map(manifestOf);
}

/** Full install payload for one skill (for GET /api/skills/[name]). */
export function getSkillInstall(name: string) {
  const s = getSkillDef(name);
  if (!s) return null;
  return {
    ...manifestOf(s),
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
