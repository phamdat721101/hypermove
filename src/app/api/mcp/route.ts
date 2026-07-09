import type { NextRequest } from 'next/server';
import { wrapAgentEndpoint, wrapMcpTool, McpToolDenied } from '@/lib/observability';
import { defaultSentinel } from '@/lib/sentinel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/mcp — minimal JSON-RPC 2.0 MCP surface.
 * Exposes 2 tools: `payment.x402` (proxies /api/paid-endpoint) and `reputation.read` (mock).
 *
 * v2.0: each tool handler is individually wrapped by wrapMcpTool for per-tool
 * tracing + policy checks. The outer route is wrapped by wrapAgentEndpoint
 * so batch / infrastructure events (parse errors, malformed JSON-RPC) are
 * also captured. Both wrappers are identity functions when FEATURE_HM_PLATFORM=false.
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

// ─── Individual tool handlers, wrapped for per-tool tracing ────────────────

const callPaymentX402 = wrapMcpTool({
  name: 'payment.x402',
  version: '1.0.0',
  sentinel: defaultSentinel(),
  handler: async (args: { target?: string; origin: string }) => {
    const target = String(args.target ?? '/api/paid-endpoint');
    const res = await fetch(new URL(target, args.origin), {
      headers: { 'x-payment': 'mock-eip3009-sig-base64' },
    });
    return res.json();
  },
});

const callReputationRead = wrapMcpTool({
  name: 'reputation.read',
  version: '1.0.0',
  sentinel: defaultSentinel(),
  handler: async (args: { agent?: string }) => ({
    agent: args.agent ?? '0xUnknown',
    score: 0.93,
    attestations: 42,
    source: 'erc-8004 mock',
  }),
});

async function handlePost(req: NextRequest): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return jsonRpcError(body.id ?? null, -32600, 'Invalid request');
  }

  const agentId = req.headers.get('x-hypermove-agent-id') ?? 'anonymous';

  switch (body.method) {
    case 'tools/list':
      return jsonRpcResult(body.id ?? null, { tools: TOOLS });
    case 'tools/call': {
      const name = (body.params as { name?: string } | undefined)?.name;
      const args = (body.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {};
      try {
        if (name === 'payment.x402') {
          const origin = new URL(req.url).origin;
          const out = await callPaymentX402({ ...(args as { target?: string }), origin }, agentId);
          return jsonRpcResult(body.id ?? null, out);
        }
        if (name === 'reputation.read') {
          const out = await callReputationRead(args as { agent?: string }, agentId);
          return jsonRpcResult(body.id ?? null, out);
        }
        return jsonRpcError(body.id ?? null, -32601, `unknown tool: ${name}`);
      } catch (err) {
        if (err instanceof McpToolDenied) {
          return jsonRpcError(body.id ?? null, -32402, `policy_denied: ${err.message}`);
        }
        throw err; // outer wrapAgentEndpoint captures + re-throws
      }
    }
    default:
      return jsonRpcError(body.id ?? null, -32601, `unknown method: ${body.method}`);
  }
}

export const POST = wrapAgentEndpoint({
  name: 'hypermove.mcp',
  version: '1.0.0',
  sentinel: defaultSentinel(),
  handler: handlePost,
});

export async function GET() {
  return Response.json({ jsonrpc: '2.0', endpoint: '/api/mcp', tools: TOOLS.map((t) => t.name) });
}

function jsonRpcResult(id: number | string | null, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result });
}
function jsonRpcError(id: number | string | null, code: number, message: string) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status: 200 });
}
