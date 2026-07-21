/**
 * src/hypermove.client.ts
 * ------------------------
 * Calls HyperMove's MCP gateway and normalizes every real response shape
 * this codebase actually produces into one internal result type.
 *
 * Ground truth (read directly from hypermove-app, not assumed from the
 * original PRD):
 *  - src/app/api/mcp/route.ts's legacy JSON-RPC 2.0 path: request is
 *    { jsonrpc:'2.0', id, method:'tools/call', params:{ name, arguments } };
 *    response is ALWAYS HTTP 200 with either { jsonrpc, id, result } or
 *    { jsonrpc, id, error:{ code, message, data } } — there is no HTTP 402
 *    status or WWW-Authenticate header on this path. The payment challenge
 *    (see paywall.ts's buildChallenge()) is delivered as the JSON-RPC
 *    error's `data` field with `code: -32402`.
 *  - The real default transport when FEATURE_HYPERMOVE_MCP_GATEWAY_V1 is ON
 *    (the default) is actually the MCP Streamable-HTTP protocol
 *    (mcpHttpHandler(), src/lib/mcp/server.ts), not this legacy JSON-RPC
 *    surface. This client targets the legacy JSON-RPC fallback path
 *    deliberately — implementing a full MCP Streamable-HTTP client is out
 *    of scope for this ship (see README's "Transport boundary" section);
 *    reaching it requires either FEATURE_HYPERMOVE_MCP_GATEWAY_V1=false on
 *    the HyperMove deployment, or a documented follow-up to speak real MCP.
 *    Named explicitly rather than silently assumed.
 *  - src/lib/mcp/envelope.ts's ServiceResult<T> contract: tool results are
 *    { ok:true, data } or { ok:false, error:{ service, kind, message, ... } }.
 *    CRITICAL RULE (from the PRD, confirmed real): kind === 'soft-empty' is
 *    NOT an error — treat as success with empty/null data.
 *  - src/lib/mcp/auth.ts's admin-token bypass: Authorization: Bearer <token>
 *    (or x-mcp-admin-token header) where token === HYPERMOVE_MCP_ADMIN_TOKEN.
 *    KNOWN TRADEOFF: this grants admin tier — bypasses paywall/rate-limit
 *    entirely. See README "Known tradeoff: admin-token reuse".
 */

export interface HyperMoveCallInput {
  tool: string;
  arguments: Record<string, unknown>;
  baseUrl: string;
  bearerToken: string;
  /** Optional request id; defaults to 1 (single in-flight call per request). */
  id?: number;
  timeoutMs?: number;
}

export interface ServiceErrorShape {
  service?: string;
  kind?: 'error' | 'soft-empty';
  message: string;
  status?: number;
  code?: string;
  hint?: string;
}

export type HyperMoveCallResult =
  | { kind: 'ok'; data: unknown }
  /** soft-empty is normalized into the SAME success shape as 'ok' with
   *  data: null — per the critical rule above, callers must never branch
   *  on this differently from a real success. This variant exists only so
   *  index.ts's ActionResult log can honestly say "no data" instead of
   *  fabricating a description of nonexistent data. */
  | { kind: 'ok'; data: null; softEmpty: true; message: string }
  | { kind: 'payment_required'; challenge: unknown; message: string }
  | { kind: 'error'; message: string; code?: number | string }
  | { kind: 'network_error'; message: string };

const DEFAULT_TIMEOUT_MS = 10_000;
const PAYMENT_REQUIRED_JSONRPC_CODE = -32402;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** True if a tool result matches src/lib/mcp/envelope.ts's ServiceResult
 *  failure shape with kind: 'soft-empty'. Structural check (no import from
 *  hypermove-app — this project is intentionally standalone), matching
 *  exactly the fields envelope.ts's softEmpty()/fail() construct. */
function isSoftEmptyEnvelope(value: unknown): value is { ok: false; error: ServiceErrorShape } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.ok !== false || !v.error || typeof v.error !== 'object') return false;
  const err = v.error as Record<string, unknown>;
  return err.kind === 'soft-empty' && typeof err.message === 'string';
}

function isErrorEnvelope(value: unknown): value is { ok: false; error: ServiceErrorShape } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.ok === false && !!v.error && typeof v.error === 'object';
}

/**
 * Call a HyperMove MCP tool via the legacy JSON-RPC 2.0 surface, normalizing
 * every real outcome (success / soft-empty / 402-shaped JSON-RPC error /
 * generic error / network failure) into one HyperMoveCallResult. Never
 * throws — network and parse failures both resolve to a typed result.
 */
export async function callHyperMoveTool(input: HyperMoveCallInput): Promise<HyperMoveCallResult> {
  const { tool, arguments: args, baseUrl, bearerToken, id = 1, timeoutMs = DEFAULT_TIMEOUT_MS } = input;

  let res: Response;
  try {
    res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { kind: 'network_error', message: err instanceof Error ? err.message : String(err) };
  }

  let body: JsonRpcResponse;
  try {
    body = (await res.json()) as JsonRpcResponse;
  } catch (err) {
    return { kind: 'network_error', message: `non-JSON response (HTTP ${res.status}): ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!res.ok) {
    return { kind: 'network_error', message: `HTTP ${res.status}: ${JSON.stringify(body)}` };
  }

  if (body.error) {
    if (body.error.code === PAYMENT_REQUIRED_JSONRPC_CODE) {
      return { kind: 'payment_required', challenge: body.error.data, message: body.error.message };
    }
    return { kind: 'error', message: body.error.message, code: body.error.code };
  }

  const result = body.result;
  if (isSoftEmptyEnvelope(result)) {
    return { kind: 'ok', data: null, softEmpty: true, message: result.error.message };
  }
  if (isErrorEnvelope(result)) {
    return { kind: 'error', message: result.error.message, code: result.error.code };
  }
  // Plain success — either a raw ServiceResult{ok:true,data} envelope or (for
  // the two legacy demo tools in route.ts, payment.x402/reputation.read) a
  // bare object with no envelope at all. Unwrap .data when present, else
  // pass the whole result through — both are genuine "ok" outcomes.
  if (result && typeof result === 'object' && (result as Record<string, unknown>).ok === true) {
    return { kind: 'ok', data: (result as Record<string, unknown>).data };
  }
  return { kind: 'ok', data: result ?? null };
}
