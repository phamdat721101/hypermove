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
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { NextRequest } from 'next/server';
import { getTools, type ToolDef } from './tools';
import { getPrompts, type PromptDef } from './prompts';
import { getResources, type McpResource } from './resources';
import { isMcpResourcesEnabled } from '../platform-flag';
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
 *
 * PRD-B fix (2026-07-27 dream-cycle-practical-readiness-feedback): a nested
 * `object` with declared `properties` (e.g. start_dream's `config`) used to
 * ALWAYS coerce to `z.record(z.string(), z.any())`, discarding every nested
 * field's type/enum/minimum — meaning tools/list (which re-derives its
 * advertised schema from this Zod shape, not from the raw ToolDef.inputSchema
 * directly) never actually exposed a client-validatable nested shape, even
 * after tools.ts declared one. `toObjectSchema()` below recurses into
 * `properties` (one level is enough for every schema in this codebase today
 * — none nest deeper) and falls back to the pre-existing untyped-record
 * behavior only when no `properties` are declared, so every other tool's
 * plain `{type:'object'}` param keeps its exact prior behavior.
 */
function toFieldSchema(def: { type?: string; description?: string; enum?: string[]; minimum?: number; default?: unknown; items?: { type?: string }; properties?: Record<string, JsonSchemaFieldDef>; required?: string[] }): ZodTypeAny {
  let field: ZodTypeAny =
    def.type === 'number' ? (def.minimum !== undefined ? z.number().min(def.minimum) : z.number())
    : def.type === 'boolean' ? z.boolean()
    : def.type === 'array' ? z.array(def.items?.type === 'object' ? z.record(z.string(), z.any()) : z.any())
    : def.type === 'object' ? toObjectSchema(def)
    : def.enum ? z.enum(def.enum as [string, ...string[]])
    : z.string();
  if (def.description) field = field.describe(def.description);
  return field;
}

interface JsonSchemaFieldDef {
  type?: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  default?: unknown;
  items?: { type?: string };
  properties?: Record<string, JsonSchemaFieldDef>;
  required?: string[];
}

/** Builds a Zod object schema from a nested `properties`/`required` pair —
 *  falls back to the pre-existing untyped record when no properties are
 *  declared, so a plain `{type:'object'}` param (no nested shape) behaves
 *  exactly as it did before this fix. */
function toObjectSchema(def: { properties?: Record<string, JsonSchemaFieldDef>; required?: string[] }): ZodTypeAny {
  if (!def.properties) return z.record(z.string(), z.any());
  const required = new Set(def.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, fieldDef] of Object.entries(def.properties)) {
    const field = toFieldSchema(fieldDef);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(shape);
}

export function toZodShape(inputSchema: Record<string, unknown>): ZodRawShape {
  const props = (inputSchema?.properties as Record<string, JsonSchemaFieldDef>) ?? {};
  const required = new Set((inputSchema?.required as string[]) ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, def] of Object.entries(props)) {
    const field = toFieldSchema(def);
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

/**
 * The MCP Prompts primitive — net-new (see prompts.ts's module doc for why
 * nothing before this called server.registerPrompt() despite
 * isMcpResourcesEnabled() existing). Mirrors registerTool()'s exact shape:
 * PromptDef.arguments (always plain strings per the MCP spec's prompt
 * argument contract, unlike a tool's arbitrarily-typed inputSchema) becomes
 * a Zod raw shape of z.string()/z.string().optional(); PromptDef.resolve()'s
 * PromptMessage[] return is wrapped 1:1 into the SDK's GetPromptResult shape
 * ({messages: [...]}) — no reshaping needed since prompts.ts's PromptMessage
 * type was defined to match the SDK's shape exactly.
 */
export function registerPrompt(server: Parameters<Parameters<typeof createMcpHandler>[0]>[0], prompt: PromptDef): void {
  const argsSchema: Record<string, ZodTypeAny> = {};
  for (const arg of prompt.arguments) {
    let field: ZodTypeAny = z.string();
    if (arg.description) field = field.describe(arg.description);
    argsSchema[arg.name] = arg.required ? field : field.optional();
  }

  server.registerPrompt(
    prompt.name,
    { description: prompt.description, argsSchema: argsSchema as ZodRawShape },
    async (args) => {
      const messages = await prompt.resolve((args ?? {}) as Record<string, string | undefined>);
      return { messages };
    },
  );
}

/**
 * Task 7 (2026-08-10, dream-cycle-fcc-live-session-feedback plan). The MCP
 * Resources primitive — net-new, closing a documented "Known gap" (see
 * docs/prd/dream-cycle-flare-confidential-v1.md): resources.ts's 4 Dream
 * Cycle resources (dream/summary|rules|errors|stats) and the FTSO/XRPL/FXRP
 * static resources were always fully implemented and unit-tested in
 * isolation, but never reachable via a real `resources/list`/`resources/read`
 * MCP call — nothing before this called server.registerResource() (mirrors
 * registerPrompt()'s exact "data layer already existed, only transport
 * wiring was missing" shape).
 *
 * McpResource.uri is either a fixed URI (no `{param}`, e.g. "xrpl://amendments")
 * or a path template (e.g. "hypermove:///agents/{agent_id}/dream/summary").
 * The SDK's registerResource() overloads require a STRING for a fixed URI vs
 * a ResourceTemplate instance for a templated one — this function picks the
 * right overload per-resource rather than forcing every resource through one
 * shape. Every resource's `read(matchedUri)` already accepts the exact
 * requested URI string and does its own param extraction internally
 * (resources.ts's extractAgentId()) — this function reuses that as-is,
 * never re-implementing URI parsing here.
 *
 * `list: undefined` on the ResourceTemplate is intentional (not a stub to
 * fill in later): resources.ts's own module doc explains these are strictly
 * per-agent, scoped by the {agent_id} in the requested URI — there is no
 * finite, enumerable "list every agent's dream/summary" operation to offer,
 * matching the SDK's own documented meaning of an omitted list callback (the
 * template resource is reachable via `resources/read` but never appears as
 * a synthesized entry in a `resources/list` response).
 */
export function registerResource(server: Parameters<Parameters<typeof createMcpHandler>[0]>[0], resource: McpResource): void {
  const config = { description: resource.description, mimeType: resource.mimeType };

  const readCallback = async (uri: URL) => {
    const result = await resource.read(uri.toString());
    return {
      contents: [{ uri: uri.toString(), mimeType: resource.mimeType, text: JSON.stringify(result) }],
    };
  };

  if (resource.uri.includes('{')) {
    const template = new ResourceTemplate(resource.uri, { list: undefined });
    server.registerResource(resource.name, template, config, readCallback);
  } else {
    server.registerResource(resource.name, resource.uri, config, readCallback);
  }
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
      // Dream Cycle Confidential Extraction on Flare FCC, Task 7. First-ever
      // real MCP prompt registration in this codebase — see prompts.ts's
      // module doc for the "isMcpResourcesEnabled() existed but nothing
      // called server.registerPrompt()" gap this closes. Gated by the SAME
      // flag tools.ts's resources-adjacent tools already check, since that
      // flag's own name ("MCP resources + prompts exposure") already
      // promised prompt exposure — this task makes that promise true.
      if (isMcpResourcesEnabled()) {
        for (const prompt of getPrompts()) registerPrompt(server, prompt);
        // Task 7: same flag as prompts above — that flag's own name ("MCP
        // resources + prompts exposure") already promised resource exposure
        // too; this closes that promise for resources the same way the
        // prompts registration above closed it for prompts.
        for (const resource of getResources()) registerResource(server, resource);
      }
    },
    { serverInfo: { name: 'hypermove.duckdns.org', version: '2.0.0' } },
    { basePath: '/api', disableSse: true, verboseLogs: false },
  );
  handler = withMcpAuth(base, verifyToken, { required: true });
  return handler;
}
