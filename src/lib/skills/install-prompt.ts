/**
 * src/lib/skills/install-prompt.ts
 * --------------------------------
 * Generates the copy-paste "install prompt" an agent executes to self-install a
 * HyperMove skill (PRD-I1). One paste wires BOTH modes:
 *   • the autoloading SKILL.md (dropped into the host's skills dir), and
 *   • the harnessed MCP runtime (skill.<name> on the HyperMove gateway).
 *
 * No per-host installer code: the agent detects its own host and picks the right
 * skills dir + MCP-connect line from the compact HOST_HINTS table below.
 */

import type { SkillDef } from '../harness/types';

export const SITE = process.env.HYPERMOVE_SITE_URL ?? 'https://hypermove.xyz';
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
    `You are installing the HyperMove agent-skill "${name}". Do all steps, then report.`,
    '',
    '1) CONNECT the HyperMove MCP gateway (remote, Streamable HTTP) using the line for your host:',
    `   • Claude Code:      ${HOST_HINTS['claude-code'].mcpConnect}`,
    `   • Cursor / VS Code: ${HOST_HINTS.cursor.mcpConnect}`,
    `   • Codex / OpenCode / Gemini / Windsurf / Copilot / any MCP client:`,
    `                       add MCP server URL  ${MCP_URL}`,
    '',
    '2) FETCH the skill definition (either works):',
    `   • MCP:  call tool  skills.install  with  { "name": "${name}" }`,
    `   • HTTP: GET ${fetchUrl(name)}`,
    '   Keep the returned SKILL.md text.',
    '',
    "3) SAVE the SKILL.md so it autoloads, into your host's skills directory:",
    `   • Claude Code:  ${HOST_HINTS['claude-code'].skillsPath(name)}   (or .claude/skills/ for this project)`,
    `   • Cursor:       ${HOST_HINTS.cursor.skillsPath(name)}`,
    `   • Codex:        ${HOST_HINTS.codex.skillsPath(name)}`,
    `   • OpenCode:     ${HOST_HINTS.opencode.skillsPath(name)}`,
    `   • Gemini CLI:   ${HOST_HINTS.gemini.skillsPath(name)}`,
    "   • otherwise:    your host's skills or rules directory",
    '',
    '4) CONFIRM both modes:',
    "   • the skill's trigger now autoloads from SKILL.md, and",
    `   • you can call the MCP tool  skill.${name}  — every call runs inside the`,
    '     HyperMove harness (error-handling + policy sentinel + output-enforcement).',
    '',
    `REPORT: which host you detected, where you saved the SKILL.md, and the result of a`,
    `test call to skill.${name}.`,
  ].join('\n');
}

/** Tightened variant when the host is known. */
function hostPrompt(name: string, host: Host): string {
  const h = HOST_HINTS[host];
  return [
    `Install the HyperMove skill "${name}" in ${h.label}:`,
    `1) Connect MCP:  ${h.mcpConnect}`,
    `2) Fetch + save:  GET ${fetchUrl(name)}  →  ${h.skillsPath(name)}  (create the folder if needed)`,
    `3) Reload so the skill autoloads.`,
    `4) Confirm you can call skill.${name} — it runs inside the HyperMove harness. Report where you saved it and the test-call result.`,
  ].join('\n');
}

/** One-line "share link" variant (khengyun-gist style) for chat brevity. */
export function shareLinePrompt(name: string): string {
  return `Install + use the HyperMove skill ${name}: connect MCP ${MCP_URL}, save ${fetchUrl(name)} into your skills dir, then call skill.${name} (harness-wrapped). Confirm both and report.`;
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
