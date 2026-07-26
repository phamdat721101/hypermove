/**
 * src/lib/mcp/server.ts
 * ---------------------
 * The REAL Model Context Protocol server (Streamable HTTP transport) — the
 * thing that makes /api/mcp connectable by native MCP clients (Claude Desktop,
 * Cursor, MCP Inspector, agent SDKs) instead of a bespoke JSON-RPC endpoint.
 *
 * SOLID:
 *  - Single Responsibility: transport + auth bridge ONLY. The tool registry
 *    (tools.ts) stays the single source of truth; this file iterates it.
 *  - Dependency Inversion: every tool is dispatched through gateway.callTool —
 *    the one metering/ledger seam — never by calling handlers directly. So
 *    auth, free-tier metering, paid sessions and the call ledger all apply
 *    unchanged over the MCP transport.
 *
 * Payment over MCP: settlement is in-band via the `payments.settle` tool
 * (n-payment). A metered call that exceeds the free tier returns an MCP error
 * whose `data` carries the x402 challenge; the agent calls payments.settle,
 * which opens a paid session that subsequent calls consume.
 */

import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { NextRequest } from 'next/server';
import { getTools, type ToolDef } from './tools';
import { callTool } from './gateway';
import { authenticate, type McpSession } from './auth';

/**
 * Minimal JSON-Schema → Zod shape for our simple object schemas
 * (string/number/boolean/object/array). Exported for direct unit testing —
 * see tests/mcp-dream-cycle.test.ts's "submit_episode_log tool — episodes
 * shape validation" suite, added after a production bug where `episodes`
 * was declared `{ type: 'object' }` (coerces to z.record — rejects a real
 * array) instead of `{ type: 'array' }`. Before that fix, this function had
 * NO array case at all: `type: 'array'` would have silently fallen through
 * to the `z.string()` default, which is a DIFFERENT and equally-wrong
 * failure mode than the object/record bug — so declaring the correct
 * inputSchema type alone is not sufficient without this case existing.
 */
export function toZodShape(inputSchema: Record<string, unknown>): ZodRawShape {
  const props = (inputSchema?.properties as Record<string, { type?: string; description?: string; items?: { type?: string } }>) ?? {};
  const required = new Set((inputSchema?.required as string[]) ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, def] of Object.entries(props)) {
    let field: ZodTypeAny =
      def.type === 'number' ? z.number()
      : def.type === 'boolean' ? z.boolean()
      : def.type === 'array' ? z.array(def.items?.type === 'object' ? z.record(z.string(), z.any()) : z.any())
      : def.type === 'object' ? z.record(z.string(), z.any())
      : z.string();
    if (def.description) field = field.describe(def.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape as ZodRawShape;
}

const ANON: McpSession = { userId: 'anonymous', tier: 'free', kind: 'user' };

function registerTool(server: Parameters<Parameters<typeof createMcpHandler>[0]>[0], tool: ToolDef): void {
  server.tool(tool.name, tool.description, toZodShape(tool.inputSchema), async (args, extra) => {
    const session = (extra.authInfo?.extra?.session as McpSession | undefined) ?? ANON;
    const outcome = await callTool({ session, name: tool.name, args: (args ?? {}) as Record<string, unknown> });
    if (outcome.error) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ error: outcome.error.message, code: outcome.error.code, data: outcome.error.data }) }],
      };
    }
    const result = outcome.result;
    const structured = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      ...(structured ? { structuredContent: structured } : {}),
    };
  });
}

/** Bridge HyperMove's 3-layer auth gate into an MCP AuthInfo (session in `extra`). */
async function verifyToken(req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  const outcome = await authenticate(req as unknown as NextRequest);
  if (!outcome.ok) return undefined;
  const s = outcome.session;
  return { token: bearer ?? 'session', clientId: s.userId, scopes: [s.tier], extra: { session: s } };
}

let handler: ((req: Request) => Promise<Response>) | null = null;

/** The Streamable-HTTP MCP handler for /api/mcp (GET/POST/DELETE), built once. */
export function mcpHttpHandler(): (req: Request) => Promise<Response> {
  if (handler) return handler;
  const base = createMcpHandler(
    (server) => {
      for (const tool of getTools()) registerTool(server, tool);
    },
    { serverInfo: { name: 'hypermove.xyz', version: '2.0.0' } },
    { basePath: '/api', disableSse: true, verboseLogs: false },
  );
  handler = withMcpAuth(base, verifyToken, { required: true });
  return handler;
}
