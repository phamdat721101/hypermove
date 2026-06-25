import type { NextRequest } from 'next/server';
import { findMCPBySlug } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/mcp/[slug] — Hosted MCP endpoint.
 *
 * Serves JSON-RPC 2.0 (tools/list, tools/call) for any generated MCP
 * stored in Supabase. Agent connects here directly — no self-hosting needed.
 *
 * Example: POST /api/mcp/uniswap-org-mcp
 */

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  const { slug } = params;

  const record = await findMCPBySlug(slug);
  if (!record) {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32001, message: `MCP not found: ${slug}` } },
      { status: 404 },
    );
  }

  const manifest = record.manifest as { name: string; version: string; tools: Array<{ name: string; description: string; inputSchema: unknown }> };

  let body: JsonRpcRequest;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }

  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(body.id ?? null, -32600, 'Invalid request');
  }

  switch (body.method) {
    case 'initialize':
      return rpcResult(body.id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: manifest.name, version: manifest.version },
        capabilities: { tools: {} },
      });

    case 'tools/list':
      return rpcResult(body.id, {
        tools: manifest.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = (body.params as { name?: string })?.name;
      const args = (body.params as { arguments?: unknown })?.arguments ?? {};
      const tool = manifest.tools.find((t) => t.name === name);
      if (!tool) return rpcError(body.id, -32601, `Unknown tool: ${name}`);
      return rpcResult(body.id, {
        content: [{ type: 'text', text: JSON.stringify({ tool: name, args, status: 'stub', source: record.sourceUrl }) }],
      });
    }

    case 'ping':
      return rpcResult(body.id, {});

    default:
      return rpcError(body.id, -32601, `Unknown method: ${body.method}`);
  }
}

/** GET returns manifest info for discovery. */
export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const record = await findMCPBySlug(params.slug);
  if (!record) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(record.manifest);
}

function rpcResult(id: string | number | null, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result });
}
function rpcError(id: string | number | null, code: number, message: string) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}
