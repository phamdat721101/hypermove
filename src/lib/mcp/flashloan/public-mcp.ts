import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createMcpHandler } from 'mcp-handler';
import { RateWindow } from './admission';
import { errorResult, ResearchError } from './contracts';
import { publicResearchRequest } from './client';
import { assertPublicValue, assertVersionEnabled, PUBLIC_LIMITS, PUBLIC_VERSION, publicSchemas, publicOperationEnabled, integrationEnabled, resolutionEnabled, type PublicOperation } from './public-contracts';
import { v8Enabled } from './v8-contracts';
import { boundedJson, boundedBody } from './transport';

const transportRate = new RateWindow(PUBLIC_LIMITS.transport_per_minute);
const descriptions: Record<PublicOperation, string> = {
  flashloan_get_watchlist_v1: 'Return a bounded liquidity-verified watchlist with pinned screening state, evidenced USD virtual depth, anchors, registry version and explicit partial coverage. Discovery only; consumers must re-read state before quoting.',
  flashloan_get_arb_universe_v1: 'Return the signed arb cycle universe at one pinned block: reviewed quotable pools with bounded tick hydration and ±50/100/200 bps depth, directed closed cycles per lendable asset with live lender capacity, ranked by verified realized arbs. Cached; a cold key returns retryable UNIVERSE_WARMING while a shared build runs. Discovery only.',
  flashloan_get_registry_v1: 'Return a versioned discovery registry of venues, lenders, converters, hooks and execution metadata. This does not authorize execution or replace consumer configuration.',
  flashloan_resolve_pool_inventory_v1: 'Resolve provider pool IDs to reviewed manager and canonical PoolKey with bounded RPC provenance. Unresolved dependencies remain explicit; no execution.',
  flashloan_research_candidates_v2: 'Compose target discovery, canonical identity, admitted snapshot and amount-aware research within one budget. Returns complete target dispositions and unsigned modeled plans.',
  flashloan_research_candidates_v1: 'Evaluate explicit tokens and optional movers against a verified EVM snapshot with bounded unequal allocation search. Returns a complete candidate ledger and modeled economics; unsigned research only.',
  flashloan_get_token_movers: 'Rank up to ten tokens per chain with at least 10% reported 24h movement among a bounded DexScreener scan. Base, Arbitrum, Robinhood and Sui; non-exhaustive market-derived evidence, no trading.',
  flashloan_capabilities: 'Public stateless research capabilities, reviewed deployments and limits. No credentials or sessions required.',
  flashloan_rlusd_devtools_v1: 'Check RLUSD provider catalogs, quote same-chain RLUSD to USDC, or verify one XRP Ledger payment or finalized Base/Ethereum transfer. Read-only. No cross-chain fill execution.',
  sui_ingest_pool_state: 'Read reviewed shared Move pools at one checkpoint. Native research requires verified deployment evidence.',
  sui_solve_arbitrage_routes: 'Search closed Sui routes with bounded native borrow/swap/repay PTB simulation. No signatures or broadcasts.',
  sui_simulate_ptb: 'Recheck object versions and dry-run an unsigned PTB with native checks enabled; reports mocked gas explicitly.',
  flashloan_discover_arbitrage_pools: 'List EVM or Sui pools, including low-liquidity and unsupported venues; disclose coverage separately. Returns research data directly, with no saved job.',
  flashloan_ingest_l2_tickmap_and_reserves: 'Read reviewed EVM pools at a canonical block. Returns an inline proven snapshot; send it unchanged to sizing.',
  flashloan_solve_dynamic_route_split: 'Size bounded routes from an inline proven snapshot. Returns a proven feasible plan or an explicit inconclusive/no-opportunity outcome.',
  flashloan_simulate_atomic_revm: 'Dry-run an inline proven plan. Reports repayment, fidelity and assumptions; never signs or broadcasts.',
  xrpl_discover_arbitrage_routes: 'Discover native XRPL books, AMMs and estimated cycles. Returns an inline proven ledger payload; hypothetical funding stays labeled.',
  xrpl_simulate_arbitrage_route: 'Estimate an inline proven XRPL payload or dry-run a supported unsigned native transaction. No broadcasting or atomicity guarantee.',
  xrpl_get_holder_report_v1: 'Compare XRP holding, assumed XRP yield, XRP/RLUSD liquidity provision and an RLUSD buffer under a price scenario. Use a fresh xrpl_routes envelope from discovery to estimate separate AMM and funded order-book exits in RLUSD.',
};
const annotatedReadOnlyTools = new Set<PublicOperation>([
  'flashloan_get_token_movers', 'flashloan_get_watchlist_v1', 'flashloan_get_registry_v1', 'flashloan_get_arb_universe_v1', 'flashloan_rlusd_devtools_v1', 'xrpl_get_holder_report_v1',
]);
function allowedOrigins(url: URL) {
  const configured = (process.env.FLASHLOAN_PUBLIC_ORIGINS ?? 'https://mcp.overguild.com,https://hypermove.xyz,https://hypermove.duckdns.org').split(',').map((v) => v.trim()).filter(Boolean);
  if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) configured.push(url.origin);
  return configured;
}
function toolFailure(operation: string, cause: unknown) {
  const error = errorResult(cause);
  const result = { schema_version: PUBLIC_VERSION, request_id: randomUUID(), operation, ok: false, error: { ...error, ...(error.retryable ? { retry_after_ms: error.code === 'RATE_LIMITED' ? 60000 : 5000 } : {}) } };
  return { isError: true as const, structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}
async function readRequest(request: Request) {
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
  try { return await boundedJson(new Response(request.body), PUBLIC_LIMITS.body_bytes, controller.signal, integrationEnabled() || resolutionEnabled() || v8Enabled('INVENTORY_V3') || v8Enabled('MOVERS_V2') || v8Enabled('REGISTRY_V1')); }
  catch (e) { if (timedOut) throw new ResearchError('REQUEST_TIMEOUT', 'Request body exceeded its ten-second deadline.', true); throw e; }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
}
/** Dedicated catalog: never authenticates, meters, reads owned artifacts or writes knowledge. */
export async function publicMcpHandler(request: Request): Promise<Response> {
  if (process.env.FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS !== 'true') return Response.json({ error: 'PUBLIC_DISABLED' }, { status: 404 });
  const url = new URL(request.url), origin = request.headers.get('origin');
  const allowedHosts = (process.env.FLASHLOAN_PUBLIC_HOSTS ?? 'mcp.overguild.com,localhost,127.0.0.1,[::1]').split(',').map((v) => v.trim());
  if (!allowedHosts.includes(url.hostname) || origin && !allowedOrigins(url).includes(origin)) return Response.json({ error: 'ORIGIN_REJECTED' }, { status: 403 });
  const cors: Record<string, string> = { 'cache-control': 'no-store', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, Accept, MCP-Protocol-Version', vary: 'Origin' };
  if (origin) cors['access-control-allow-origin'] = origin;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...cors, allow: 'POST, OPTIONS' } });
  try {
    const address = process.env.FLASHLOAN_TRUST_PROXY === 'true' ? request.headers.get('x-flashloan-client-ip') : '127.0.0.1';
    if (!address || !isIP(address)) throw new ResearchError('PROXY_UNCONFIGURED', 'Trusted proxy did not supply a valid client address.');
    const admissionKey = createHash('sha256').update('public-admission:' + new Date().toISOString().slice(0, 10) + ':' + address).digest('hex');
    transportRate.take(admissionKey);
    const raw = await readRequest(request);
    assertPublicValue(raw);
    // Normalize validation before SDK callbacks, whose own errors are otherwise plain text.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const rpc = raw as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } };
      if (typeof rpc.id === 'string' && rpc.id.length > 128) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request ID exceeds the public limit.' } }, { headers: cors });
      if (rpc.jsonrpc === '2.0' && rpc.method === 'tools/call') {
        const name = rpc.params?.name;
        let failure: ResearchError | undefined;
        try { if (typeof name === 'string') assertVersionEnabled(name, rpc.params?.arguments); } catch (error) { if (error instanceof ResearchError) failure = error; else throw error; }
        if (!failure && (typeof name !== 'string' || (!Object.hasOwn(publicSchemas, name) || !publicOperationEnabled(name)))) failure = new ResearchError('UNKNOWN_OPERATION', 'Unknown public research tool.');
        else if (!failure && !publicSchemas[name as PublicOperation].safeParse(rpc.params?.arguments ?? {}).success) failure = new ResearchError('INVALID_INPUT', 'Invalid public research input.');
        if (failure) return Response.json({ jsonrpc: '2.0', id: typeof rpc.id === 'string' || typeof rpc.id === 'number' ? rpc.id : null, result: toolFailure(typeof name === 'string' && Object.hasOwn(publicSchemas, name) ? name : 'unknown', failure) }, { headers: cors });
      }
    }
    // The per-request closure carries cancellation and admission context without mutable globals.
    const handler = createMcpHandler((server) => {
      for (const name of Object.keys(publicSchemas).filter(publicOperationEnabled) as PublicOperation[]) {
        server.registerTool(name, { description: name === 'flashloan_get_token_movers' && v8Enabled('MOVERS_V2') ? 'Rank candidates with explicit version selection. v1 preserves daily movers; v2 uses multiple sources and evidenced live pool depth. Missing signals remain explicit; no trading.' : descriptions[name], inputSchema: publicSchemas[name], ...(annotatedReadOnlyTools.has(name) ? { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } } : {}) }, async (input: Record<string, unknown>) => {
          try {
            const result = await publicResearchRequest(name, input, admissionKey, request.signal) as Record<string, unknown>;
            return { structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (e) {
            return toolFailure(name, e);
          }
        });
      }
    }, { serverInfo: { name: 'HyperMove public flashloan research', version: PUBLIC_VERSION } }, { streamableHttpEndpoint: '/api/mcp/flashloan', disableSse: true, maxDuration: 70, verboseLogs: false });
    // Fixed internal path also supports reverse-proxy root aliases.
    const target = new URL('/api/mcp/flashloan', url);
    const response = await handler(new Request(target, { method: 'POST', headers: request.headers, body: JSON.stringify(raw), signal: request.signal }));
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    // Apply the final cap to SDK-generated protocol/validation errors as well as tool results.
    return new Response(response.body ? await boundedBody(response, PUBLIC_LIMITS.body_bytes, request.signal) : null, { status: response.status, headers: response.headers });
  } catch (e) {
    const error = errorResult(e);
    const status = error.code === 'RATE_LIMITED' ? 429 : error.code === 'CAPACITY_EXCEEDED' ? 503 : error.code === 'REQUEST_TIMEOUT' ? 408 : error.code === 'INPUT_BUDGET' || error.code === 'RESPONSE_TOO_LARGE' ? 413 : error.code === 'PROXY_UNCONFIGURED' ? 503 : 400;
    return Response.json({ ok: false, error }, { status, headers: { ...cors, ...(error.retryable ? { 'retry-after': '60' } : {}) } });
  }
}
