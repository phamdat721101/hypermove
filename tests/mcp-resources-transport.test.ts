/**
 * tests/mcp-resources-transport.test.ts
 * ----------------------------------------
 * Task 7 (2026-08-10, dream-cycle-fcc-live-session-feedback plan). The FIRST
 * real MCP-protocol integration test for the Resources primitive in this
 * codebase — resources.ts's 4 Dream Cycle resources (dream/summary|rules|
 * errors|stats) and the 3 static resources (ftso/xrpl/flare) were previously
 * only unit-tested in isolation (calling .read() directly), never proven
 * reachable via a real resources/list or resources/read MCP call. This is
 * the exact "Known gap" documented in
 * docs/prd/dream-cycle-flare-confidential-v1.md, closed by server.ts's new
 * registerResource().
 *
 * Uses the SDK's own sanctioned InMemoryTransport.createLinkedPair(), same
 * as tests/mcp-prompts-transport.test.ts (see that file's header comment for
 * why — mcp-handler's HTTP transport adapter is genuinely runtime-bound, not
 * something Vitest can drive standalone; InMemoryTransport still exercises
 * the real production registerResource() function against a real McpServer,
 * only the outer transport differs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const ENV_KEYS = ['FEATURE_HYPERMOVE_MCP_GATEWAY_V1', 'FEATURE_MCP_DREAM_CYCLE', 'FEATURE_MCP_RESOURCES', 'FEATURE_MCP_FLARE', 'FEATURE_MCP_XRPL_V3'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.doUnmock('../src/lib/db');
  vi.resetModules();
});

/**
 * Builds a real McpServer, registers resources through the SAME
 * registerResource() function server.ts's mcpHttpHandler() calls (dynamically
 * imported so per-test env vars are read at call time, not module load),
 * connects it to a real Client over an in-memory transport pair, and returns
 * the connected client. Exercises registerResource()'s exact production code
 * path — only the outer HTTP transport differs from mcpHttpHandler().
 */
async function connectedClient(): Promise<Client> {
  vi.resetModules();
  const { registerResource } = await import('../src/lib/mcp/server');
  const { getResources } = await import('../src/lib/mcp/resources');
  const { isMcpResourcesEnabled } = await import('../src/lib/platform-flag');

  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  if (isMcpResourcesEnabled()) {
    for (const resource of getResources()) registerResource(server as never, resource);
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Minimal fake DB so getDreamStats/queryDream degrade to their documented
 *  no-DB no-op shape rather than throwing when DATABASE_URL is unset in this
 *  test process — mirrors every other dream/* test file's withClient mock. */
function installFakeDreamDb(runRow?: { agent_id: string; status: string; started_at: string; budget_used_usd: string; stages_completed: string[] }, memoryRows: { memory_id: string; agent_id: string; type: string; content: string; confidence: number; embedding: number[] }[] = []) {
  vi.doMock('../src/lib/db', () => ({
    withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM dream_cycle_runs WHERE agent_id')) {
          return runRow && runRow.agent_id === (params[0] as string) ? { rows: [runRow] } : { rows: [] };
        }
        if (sql.includes('COUNT(*)::text AS count')) {
          return { rows: [{ count: String(memoryRows.filter((r) => r.agent_id === (params[0] as string)).length) }] };
        }
        if (sql.includes('FROM dream_consolidated_memories WHERE agent_id')) {
          return { rows: memoryRows.filter((r) => r.agent_id === (params[0] as string)) };
        }
        return { rows: [] };
      }),
    })),
  }));
}

describe('Task 7 · MCP Resources primitive — real SDK protocol round-trip', () => {
  it('resources/list returns the Dream Cycle resource templates when isMcpResourcesEnabled() + Dream Cycle are on', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'true';
    delete process.env.FEATURE_MCP_FLARE;
    delete process.env.FEATURE_MCP_XRPL_V3;
    installFakeDreamDb();

    const client = await connectedClient();
    const { resourceTemplates } = await client.listResourceTemplates();
    const uris = resourceTemplates.map((r) => r.uriTemplate);
    expect(uris).toContain('hypermove:///agents/{agent_id}/dream/summary');
    expect(uris).toContain('hypermove:///agents/{agent_id}/dream/rules');
    expect(uris).toContain('hypermove:///agents/{agent_id}/dream/errors');
    expect(uris).toContain('hypermove:///agents/{agent_id}/dream/stats');
    expect(uris).toContain('hypermove:///agents/{agent_id}/dream/wake');
  });

  it('resources/list has no handler at all (-32601) when isMcpResourcesEnabled() is off — same "not even discoverable" discipline as prompts', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'false';
    installFakeDreamDb();

    const client = await connectedClient();
    // Zero registerResource() calls means the SDK never wires a
    // resources/list (or resources/templates/list) handler at all — the
    // correct MCP behavior is "Method not found" (-32601), not an empty
    // list, mirroring mcp-prompts-transport.test.ts's identical assertion
    // for prompts/list under the same flag-off condition.
    await expect(client.listResources()).rejects.toMatchObject({ code: -32601 });
  });

  it('resources/read on hypermove:///agents/{agent_id}/dream/summary returns real getDreamStats()-derived data through the actual SDK transport', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'true';
    installFakeDreamDb({ agent_id: 'robot-42', status: 'completed', started_at: '2026-08-10T00:00:00.000Z', budget_used_usd: '0.01', stages_completed: ['preprocessing'] });

    const client = await connectedClient();
    const result = await client.readResource({ uri: 'hypermove:///agents/robot-42/dream/summary' });
    expect(result.contents).toHaveLength(1);
    const body = JSON.parse((result.contents[0] as { text: string }).text);
    expect(body.agent_id).toBe('robot-42');
    expect(body.status).toBe('completed');
  });

  // The literal proof of "an agent retrieves its own learned knowledge via
  // the real MCP protocol" — this is the exact loop the 3 pre-existing
  // prompts (dream/summarize_today etc., prompts.ts) already assumed worked.
  it('resources/read on hypermove:///agents/{agent_id}/dream/rules returns consolidated rules data via the real MCP protocol', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'true';
    installFakeDreamDb(undefined, [
      { memory_id: 'mem-1', agent_id: 'robot-42', type: 'rule', content: 'always retry after cooldown', confidence: 0.9, embedding: [0.1, 0.2, 0.3] },
      { memory_id: 'mem-2', agent_id: 'robot-42', type: 'error_pattern', content: 'gripper timeout', confidence: 0.9, embedding: [0.4, 0.5, 0.6] },
    ]);

    const client = await connectedClient();
    const result = await client.readResource({ uri: 'hypermove:///agents/robot-42/dream/rules' });
    const body = JSON.parse((result.contents[0] as { text: string }).text);
    expect(body.agent_id).toBe('robot-42');
    expect(Array.isArray(body.rules)).toBe(true);
  });

  it('resources/read on a different agent_id never returns another agent\'s data (scoping guard)', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'true';
    installFakeDreamDb({ agent_id: 'robot-42', status: 'completed', started_at: '2026-08-10T00:00:00.000Z', budget_used_usd: '0.01', stages_completed: [] });

    const client = await connectedClient();
    const result = await client.readResource({ uri: 'hypermove:///agents/robot-99/dream/summary' });
    const body = JSON.parse((result.contents[0] as { text: string }).text);
    expect(body.agent_id).toBe('robot-99');
    expect(body.status).toBe('no_run_yet'); // no run row seeded for robot-99
  });
});
