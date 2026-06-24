import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/mcp — minimal JSON-RPC 2.0 MCP surface.
 * Exposes 2 tools: `payment.x402` (proxies /api/paid-endpoint) and `reputation.read` (mock).
 */

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'payment.x402',
    description: 'Pay an x402-USDC endpoint and return the response body.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'URL of the paid endpoint' },
      },
      required: ['target'],
    },
  },
  {
    name: 'reputation.read',
    description: "Read an agent's on-chain reputation score (ERC-8004).",
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'agent address' } },
      required: ['agent'],
    },
  },
];

export async function POST(req: NextRequest) {
  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return jsonRpcError(body.id ?? null, -32600, 'Invalid request');
  }

  switch (body.method) {
    case 'tools/list':
      return jsonRpcResult(body.id ?? null, { tools: TOOLS });
    case 'tools/call': {
      const name = (body.params as { name?: string } | undefined)?.name;
      const args = (body.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {};
      if (name === 'payment.x402') {
        const target = String(args.target ?? '/api/paid-endpoint');
        const origin = new URL(req.url).origin;
        const res = await fetch(new URL(target, origin), {
          headers: { 'x-payment': 'mock-eip3009-sig-base64' },
        });
        return jsonRpcResult(body.id ?? null, await res.json());
      }
      if (name === 'reputation.read') {
        return jsonRpcResult(body.id ?? null, {
          agent: args.agent ?? '0xUnknown',
          score: 0.93,
          attestations: 42,
          source: 'erc-8004 mock',
        });
      }
      return jsonRpcError(body.id ?? null, -32601, `unknown tool: ${name}`);
    }
    default:
      return jsonRpcError(body.id ?? null, -32601, `unknown method: ${body.method}`);
  }
}

export async function GET() {
  return Response.json({ jsonrpc: '2.0', endpoint: '/api/mcp', tools: TOOLS.map((t) => t.name) });
}

function jsonRpcResult(id: number | string | null, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result });
}
function jsonRpcError(id: number | string | null, code: number, message: string) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status: 200 });
}
