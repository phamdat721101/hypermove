/**
 * tests/mcp-prompts-transport.test.ts
 * -------------------------------------
 * Dream Cycle Confidential Extraction on Flare FCC, Task 7. The FIRST real
 * MCP-protocol integration test for the Prompts primitive in this codebase —
 * prior coverage (tests/mcp-v2.test.ts) only asserted
 * `typeof mcpHttpHandler() === 'function'`, never exercised prompts/list
 * against an actual @modelcontextprotocol/sdk server/client pair.
 *
 * Uses the SDK's own sanctioned InMemoryTransport.createLinkedPair() (see
 * @modelcontextprotocol/sdk/inMemory.js) rather than mcpHttpHandler()'s HTTP
 * transport directly — investigated first: mcp-handler's Streamable-HTTP
 * response adapter (server-response-adapter.ts) writes Node ServerResponse-
 * style chunks and throws "Unexpected chunk type: object" when driven by a
 * bare `new Request()` outside a real Next.js server runtime (confirmed via
 * a direct attempt, not assumed) — that adapter is genuinely runtime-bound,
 * not something a Vitest process can drive standalone. InMemoryTransport is
 * the SDK's own documented pattern for testing a server's real protocol
 * behavior without a network/HTTP layer, and registerPrompt() (server.ts)
 * calls the exact same real McpServer.registerPrompt() either way — the only
 * difference is the transport underneath, which registerPrompt() never
 * touches. This still proves prompts/list round-trips through the real SDK
 * server object server.ts builds, which is the actual claim Task 7 makes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const ENV_KEYS = ['FEATURE_HYPERMOVE_MCP_GATEWAY_V1', 'FEATURE_MCP_DREAM_CYCLE', 'FEATURE_MCP_DREAM_CONFIDENTIAL', 'FEATURE_MCP_RESOURCES'] as const;
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
});

/**
 * Builds a real McpServer, registers prompts through the SAME registerPrompt()
 * function server.ts's mcpHttpHandler() calls (dynamically imported so
 * per-test env vars are read at call time, not at module load), connects it
 * to a real Client over an in-memory transport pair, and returns the
 * connected client. This exercises registerPrompt()'s exact production code
 * path — only the outer HTTP transport differs from mcpHttpHandler().
 */
async function connectedClient(): Promise<Client> {
  vi.resetModules();
  const { registerPrompt } = await import('../src/lib/mcp/server');
  const { getPrompts } = await import('../src/lib/mcp/prompts');
  const { isMcpResourcesEnabled } = await import('../src/lib/platform-flag');

  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  // Mirrors mcpHttpHandler()'s own registration loop exactly (server.ts) —
  // calls the SAME registerPrompt() production function, just against a
  // freshly-constructed McpServer connected over InMemoryTransport instead
  // of mcpHttpHandler()'s cached HTTP-transport singleton. This is the
  // real production code path for prompt registration; only the outer
  // transport differs.
  if (isMcpResourcesEnabled()) {
    for (const prompt of getPrompts()) registerPrompt(server as never, prompt);
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('Task 7 · MCP Prompts primitive — real SDK protocol round-trip', () => {
  it('prompts/list returns the 3 core Dream Cycle prompts when isMcpResourcesEnabled() + Dream Cycle are on', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'true';
    delete process.env.FEATURE_MCP_DREAM_CONFIDENTIAL;

    const client = await connectedClient();
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain('dream/summarize_today');
    expect(names).toContain('dream/suggest_policy_updates');
    expect(names).toContain('dream/compare_before_after');
  });

  // (dream/run_confidential prompt tests removed 2026-08-14, FCC removal.
  // See docs/fcc-removal-proposal-2026-08-14.md.)

  it('prompts/list has no handler at all when isMcpResourcesEnabled() is off — the flag this task closes the promise on', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'false';

    const client = await connectedClient();
    // Zero registerPrompt() calls means the SDK never wires a prompts/list
    // handler at all — the correct MCP behavior is "Method not found"
    // (-32601), not an empty list. This is what "not even discoverable"
    // (this file's module doc, and prompts.ts's own doc comment) means in
    // practice at the protocol level.
    await expect(client.listPrompts()).rejects.toMatchObject({ code: -32601 });
  });
});
