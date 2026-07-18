/**
 * tests/mcp-briefs.test.ts
 * ------------------------
 * M4 builder.brief tests: deterministic composition + nim-enforcer block gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTools } from '../src/lib/mcp/tools';
import { buildBrief } from '../src/lib/mcp/briefs';

// Mock flags
const origEnv = process.env;

beforeEach(() => {
  process.env = { ...origEnv };
});

afterEach(() => {
  process.env = origEnv;
});

describe('builder.brief tools', () => {
  it('are NOT registered when FEATURE_MCP_BUILDER_BRIEF is off', () => {
    // v4.0: v3Flag() defaults ON (opt-out). Explicit '=false' is now the off-switch.
    process.env.FEATURE_MCP_BUILDER_BRIEF = 'false';
    const tools = getTools();
    expect(tools.find((t) => t.name === 'flare.builder.brief')).toBeUndefined();
    expect(tools.find((t) => t.name === 'xrpl.builder.brief')).toBeUndefined();
    expect(tools.find((t) => t.name === 'goat.builder.brief')).toBeUndefined();
  });

  it('are registered when FEATURE_MCP_BUILDER_BRIEF is on', () => {
    process.env.FEATURE_MCP_BUILDER_BRIEF = 'true';
    const tools = getTools();
    expect(tools.find((t) => t.name === 'flare.builder.brief')).toBeDefined();
    expect(tools.find((t) => t.name === 'xrpl.builder.brief')).toBeDefined();
    expect(tools.find((t) => t.name === 'goat.builder.brief')).toBeDefined();
  });

  it('returns error when flag is off', async () => {
    process.env.FEATURE_MCP_BUILDER_BRIEF = 'false';
    const result = await buildBrief('flare-mainnet');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('feature_disabled');
    }
  });
});
