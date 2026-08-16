/**
 * Shared nim-skill configuration for MCP helpers.
 *
 * This local store is only an optimization for unchanged output verification
 * and deterministic operational lessons. It is deliberately not used for
 * authentication, payment, or Dream-agent state: those are durable,
 * user-scoped PostgreSQL records and must survive process restarts.
 */

import { mergeHarness, type HarnessConfig } from 'nim-skill';

const MCP_NIM_BASE: HarnessConfig = {
  memory: {
    verifyCache: true,
    priors: true,
    ttlMs: 24 * 60 * 60 * 1000,
    store: '.nim/mcp-verify-memory.jsonl',
  },
  lessons: {
    store: '.nim/mcp-lessons.jsonl',
    ttlMs: 30 * 24 * 60 * 60 * 1000,
  },
  logCompact: {
    maxLines: 40,
    strategy: 'errors-only',
    escalateOnEmpty: true,
  },
  monitor: {
    exporters: ['file'],
    traceFile: '.nim/traces.jsonl',
    tokenAccounting: true,
  },
};

export function mcpNimHarness(overrides: HarnessConfig): HarnessConfig {
  return mergeHarness(MCP_NIM_BASE, overrides);
}
