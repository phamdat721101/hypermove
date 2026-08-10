/**
 * src/lib/skills/install-prompt.ts
 * --------------------------------
 * Generates the copy-paste "install prompt" an agent executes to self-install a
 * HyperMove skill. Install is agent-native and local-first: fetch the SKILL.md
 * and save it into the host's skills dir — no CLI, no npm, no MCP. The skill
 * then autoloads and runs in the agent's own workspace.
 *
 * MCP is OPTIONAL and only for external-protocol integration (live cross-chain
 * data / payments) — never required to install or run a skill.
 */

import type { SkillDef } from '../harness/types';

export const SITE = process.env.HYPERMOVE_SITE_URL ?? 'https://hypermove.duckdns.org';
export const MCP_URL = `${SITE}/api/mcp`;

export type Host =
  | 'claude-code' | 'cursor' | 'codex' | 'opencode' | 'gemini' | 'windsurf' | 'copilot' | 'generic';

interface HostHint {
  label: string;
  /** Where the SKILL.md autoloads from. */
  skillsPath: (name: string) => string;
  /** The one-liner that connects the HyperMove MCP for this host. */
  mcpConnect: string;
}

export const HOST_HINTS: Record<Host, HostHint> = {
  'claude-code': {
    label: 'Claude Code',
    skillsPath: (n) => `~/.claude/skills/${n}/SKILL.md`,
    mcpConnect: `claude mcp add --transport http hypermove ${MCP_URL}`,
  },
  cursor: {
    label: 'Cursor',
    skillsPath: (n) => `.cursor/rules/${n}.md`,
    mcpConnect: `add {"hypermove":{"url":"${MCP_URL}"}} to your mcp.json`,
  },
  codex: {
    label: 'Codex',
    skillsPath: (n) => `~/.codex/skills/${n}/SKILL.md`,
    mcpConnect: `add MCP server URL ${MCP_URL} (transport: http)`,
  },
  opencode: {
    label: 'OpenCode',
    skillsPath: (n) => `~/.opencode/skills/${n}/SKILL.md`,
    mcpConnect: `add MCP server URL ${MCP_URL} (transport: http)`,
  },
  gemini: {
    label: 'Gemini CLI',
    skillsPath: (n) => `~/.gemini/skills/${n}/SKILL.md`,
    mcpConnect: `add MCP server URL ${MCP_URL} (transport: http)`,
  },
  windsurf: {
    label: 'Windsurf',
    skillsPath: (n) => `~/.windsurf/skills/${n}/SKILL.md`,
    mcpConnect: `add MCP server URL ${MCP_URL} (transport: http)`,
  },
  copilot: {
    label: 'GitHub Copilot',
    skillsPath: (n) => `.github/skills/${n}/SKILL.md`,
    mcpConnect: `add MCP server URL ${MCP_URL} (transport: http)`,
  },
  generic: {
    label: 'any MCP client',
    skillsPath: (n) => `your host's skills or rules directory as ${n}/SKILL.md`,
    mcpConnect: `add MCP server URL ${MCP_URL} (transport: http)`,
  },
};

export const HOSTS = Object.keys(HOST_HINTS) as Host[];

/** Public raw-SKILL.md fetch target (PRD-I5). */
export function fetchUrl(name: string): string {
  return `${SITE}/api/skills/${name}?format=md`;
}

/**
 * The single source of truth for how a skill is installed — an honest,
 * agent-native instruction (no CLI, no npm, no MCP). Replaces the old fake
 * package-manager command: an agent already has fetch + write, and the SKILL.md
 * IS the skill.
 */
export function installLine(name: string): string {
  return `Fetch ${fetchUrl(name)} and save it as ${name}/SKILL.md in your agent's skills directory. No CLI, no npm, no MCP required.`;
}

/** Portable terminal one-liner (for humans who prefer a shell), host-aware. */
export function curlFallback(name: string, host: Host = 'generic'): string {
  const dest = HOST_HINTS[host].skillsPath(name);
  // For hosts whose skillsPath is a real path, wrap in mkdir + curl; generic
  // hosts get a directory hint instead of a runnable path.
  if (host === 'generic') {
    return `curl -s "${fetchUrl(name)}" -o "<your-skills-dir>/${name}/SKILL.md"`;
  }
  return `mkdir -p "$(dirname ${dest})" && curl -s "${fetchUrl(name)}" -o "${dest}"`;
}

/** Cursor one-click deep-link (base64 config) + connect map for all hosts. */
export function mcpConnect(): Record<string, unknown> {
  const cursorConfig = Buffer.from(JSON.stringify({ url: MCP_URL })).toString('base64');
  return {
    'claude-code': HOST_HINTS['claude-code'].mcpConnect,
    cursor: {
      'mcp.json': { hypermove: { url: MCP_URL } },
      deeplink: `cursor://anysphere.cursor-deeplink/mcp/install?name=hypermove&config=${cursorConfig}`,
    },
    generic: { url: MCP_URL, transport: 'http' },
  };
}

/** Universal, host-agnostic install prompt (agent self-detects host). */
function universalPrompt(name: string): string {
  return [
    `You are installing the HyperMove agent-skill "${name}". It runs in YOUR workspace —`,
    `no CLI, no npm, no MCP needed. Do the steps, then report.`,
    '',
    '1) FETCH the skill definition:',
    `   • GET ${fetchUrl(name)}`,
    `   • (already MCP-connected? you can instead call the tool  skills.install  { "name": "${name}" })`,
    '   Keep the returned SKILL.md text.',
    '',
    "2) SAVE it so it autoloads, into your host's skills directory:",
    `   • Claude Code:  ${HOST_HINTS['claude-code'].skillsPath(name)}   (or .claude/skills/ for this project)`,
    `   • Cursor:       ${HOST_HINTS.cursor.skillsPath(name)}`,
    `   • Codex:        ${HOST_HINTS.codex.skillsPath(name)}`,
    `   • OpenCode:     ${HOST_HINTS.opencode.skillsPath(name)}`,
    `   • Gemini CLI:   ${HOST_HINTS.gemini.skillsPath(name)}`,
    "   • otherwise:    your host's skills or rules directory",
    '',
    '3) RELOAD. The skill now autoloads from SKILL.md and runs locally by following its',
    '   own procedure — no HyperMove server or MCP connection required.',
    '',
    '4) OPTIONAL — only if this skill needs live cross-chain data or a payment, connect the',
    `   HyperMove MCP (external-protocol layer): add MCP server  ${MCP_URL}  (transport: http).`,
    `   Claude Code: ${HOST_HINTS['claude-code'].mcpConnect}`,
    '',
    `REPORT: which host you detected, where you saved the SKILL.md, and the result of a`,
    `local test run of the skill.`,
  ].join('\n');
}

/** Tightened variant when the host is known. */
function hostPrompt(name: string, host: Host): string {
  const h = HOST_HINTS[host];
  return [
    `Install the HyperMove skill "${name}" in ${h.label} — runs locally, no MCP:`,
    `1) Fetch + save:  GET ${fetchUrl(name)}  →  ${h.skillsPath(name)}  (create the folder if needed)`,
    `   Shell alt:  ${curlFallback(name, host)}`,
    `2) Reload so the skill autoloads and runs from its own procedure.`,
    `3) Optional — only for live chain data / payments: connect MCP  ${h.mcpConnect}`,
    `Report where you saved it and the local test-run result.`,
  ].join('\n');
}

/** One-line "share link" variant (khengyun-gist style) for chat brevity. */
export function shareLinePrompt(name: string): string {
  return `Install the HyperMove skill ${name}: save ${fetchUrl(name)} into your skills dir — it runs locally, no CLI/npm/MCP. (MCP ${MCP_URL} is optional, only for external protocol like payments / live chain data.) Confirm and report.`;
}

/** Build the install prompt; host-specific when provided, else universal. */
export function buildInstallPrompt(skill: Pick<SkillDef, 'name'>, host?: Host): string {
  return host && host !== 'generic' ? hostPrompt(skill.name, host) : universalPrompt(skill.name);
}

/** All per-host tightened variants (for the /tools host picker). */
export function installPromptsByHost(skill: Pick<SkillDef, 'name'>): Record<string, string> {
  const out: Record<string, string> = { generic: universalPrompt(skill.name), shareLine: shareLinePrompt(skill.name) };
  for (const host of HOSTS) if (host !== 'generic') out[host] = hostPrompt(skill.name, host);
  return out;
}
