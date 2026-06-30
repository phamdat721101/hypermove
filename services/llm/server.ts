/**
 * services/llm/server.ts
 * ----------------------
 * Standalone LLM backend service. Deploy on Lightsail.
 * Keeps API keys server-side. Hypermove FE (Vercel) calls this.
 *
 * Run: PORT=3001 npx tsx server.ts
 * Env: BEDROCK_API_KEY, BEDROCK_REGION, BEDROCK_MODEL (or ANTHROPIC_API_KEY, OPENAI_API_KEY)
 */

import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createPublicClient, http, parseUnits, decodeEventLog } from 'viem';

const PORT = Number(process.env.PORT || 3001);

// ─── DB (Supabase) ───────────────────────────────────────────────────────────
const dbPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 }) : null;

async function ensureQuotaTable() {
  if (!dbPool) return;
  await dbPool.query(`CREATE TABLE IF NOT EXISTS hypermove_user_quotas (
    wallet_address TEXT PRIMARY KEY, free_remaining INT NOT NULL DEFAULT 5,
    tier TEXT NOT NULL DEFAULT 'free', tier_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_scan_at TIMESTAMPTZ
  )`);
  await dbPool.query(`CREATE TABLE IF NOT EXISTS hypermove_used_tx_hashes (
    tx_hash TEXT PRIMARY KEY, wallet_address TEXT NOT NULL, used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
ensureQuotaTable().catch(() => {});

async function getQuota(wallet: string) {
  if (!dbPool) return { wallet_address: wallet, free_remaining: 5, tier: 'free', tier_expires_at: null };
  await dbPool.query(`INSERT INTO hypermove_user_quotas (wallet_address) VALUES ($1) ON CONFLICT DO NOTHING`, [wallet.toLowerCase()]);
  const { rows } = await dbPool.query(`SELECT wallet_address, free_remaining, tier, tier_expires_at::text FROM hypermove_user_quotas WHERE wallet_address = $1`, [wallet.toLowerCase()]);
  const q = rows[0];
  if (q.tier === 'pro' && q.tier_expires_at && new Date(q.tier_expires_at) < new Date()) {
    await dbPool.query(`UPDATE hypermove_user_quotas SET tier = 'free' WHERE wallet_address = $1`, [wallet.toLowerCase()]);
    q.tier = 'free';
  }
  return q;
}

async function consumeQuota(wallet: string): Promise<boolean> {
  if (!dbPool) return true;
  const q = await getQuota(wallet);
  if (q.tier === 'pro') return true;
  if (q.free_remaining <= 0) return false;
  await dbPool.query(`UPDATE hypermove_user_quotas SET free_remaining = free_remaining - 1, last_scan_at = NOW() WHERE wallet_address = $1`, [wallet.toLowerCase()]);
  return true;
}

async function upgradeToProTier(wallet: string): Promise<boolean> {
  if (!dbPool) return true;
  await dbPool.query(`INSERT INTO hypermove_user_quotas (wallet_address, tier, tier_expires_at) VALUES ($1, 'pro', NOW() + INTERVAL '30 days') ON CONFLICT (wallet_address) DO UPDATE SET tier = 'pro', tier_expires_at = NOW() + INTERVAL '30 days'`, [wallet.toLowerCase()]);
  return true;
}

// ─── Payment config ──────────────────────────────────────────────────────────
const PAYMENT = {
  chainId: 48816,
  useNative: true, // true = native BTC, false = ERC-20
  token: '0xbC10000000000000000000000000000000000001',
  tokenDecimals: 18,
  amount: '0.000001', // native BTC amount
  amountWei: '1000000000000', // 10^12
  treasury: '0x792cA42F2C2f9D9fB56dDBbfE9a0916AE6e98DD8',
};

const viemClient = createPublicClient({
  chain: { id: 48816, name: 'GOAT Testnet3', nativeCurrency: { name: 'BTC', symbol: 'BTC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet3.goat.network'] } } },
  transport: http('https://rpc.testnet3.goat.network'),
});

const SYSTEM_PROMPT = `You are analyzing a web page to extract user-callable actions as MCP tools.
Given the website's crawled data below, identify ALL actions a user can perform AND the read-operations they can query for live data.

Return ONLY a JSON array of tools. Each tool MUST have:
- name: snake_case identifier
- description: 1 sentence describing WHAT the tool does. NEVER bake live numeric values
  (APRs, prices, balances, TVL, supply, fees) into the description; describe the SHAPE and
  PURPOSE only. Use phrases like "current APR", "latest price", "user balance" — never
  "5% APY" or "$120M TVL". Baked-in values become stale lies the moment the page changes.
- inputSchema: JSON Schema object with properties and required fields
- endpoint (REQUIRED whenever a relevant URL exists in the "API endpoints" or "API live samples"
  sections): the absolute HTTP URL the tool maps to. The emitted server proxies tools/call here
  to return LIVE data — without an endpoint the tool ships as a static stub and is USELESS.
- method (optional, defaults to GET): GET|POST|PUT|PATCH|DELETE.

GUIDELINES:
- Emit BOTH read tools (list_/get_/fetch_ — bind to discovered API endpoints; method=GET) AND
  action tools (stake/swap/borrow/deposit — bind to form/transaction endpoints; method=POST).
- For DeFi / yield / dashboard / status pages, read tools are PRIORITY — the agent needs live
  APR/TVL/price/balance, not a description that quotes a number.
- Skip: pure navigation links, social media links, footer links, cookie banners.
- For SPAs where body text is sparse: rely on "API endpoints", "API live samples", and
  "Embedded JSON" sections — they expose the real data sources behind the rendered shell.

Return 3-15 tools. Quality > quantity. Raw JSON array only, no markdown fences.`;

// ─── Crawl logic ─────────────────────────────────────────────────────────────

interface ApiEndpoint { url: string; method: string; source: string }
interface ApiSample { url: string; method: string; status: number; contentType: string; bodyPreview: string; bodyKeys?: string[] }
interface CrawlData { url: string; title: string; description: string; text: string; headings: string[]; buttons: string[]; links: string[]; forms: string[]; scriptHints: string[]; apiEndpoints: ApiEndpoint[]; apiSamples: ApiSample[]; embeddedJson: object[] }

async function crawlUrl(url: string): Promise<CrawlData> {
  const html = await fetchPage(url);
  if (!html) return { url, title: '', description: '', text: '', headings: [], buttons: [], links: [], forms: [], scriptHints: [], apiEndpoints: [], apiSamples: [], embeddedJson: [] };

  // Extract text content (strip tags)
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const desc = html.match(/meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)?.[1] || '';
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);

  // Headings
  const headings: string[] = [];
  const hRe = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let hm; while ((hm = hRe.exec(html)) && headings.length < 30) { const t = hm[1]!.replace(/<[^>]*>/g, '').trim(); if (t.length > 2 && t.length < 100) headings.push(t); }

  // Buttons
  const buttons: string[] = [];
  const bRe = /<button[^>]*>([\s\S]*?)<\/button>/gi;
  let bm; while ((bm = bRe.exec(html)) && buttons.length < 20) { const t = bm[1]!.replace(/<[^>]*>/g, '').trim().slice(0, 60); if (t.length > 1) buttons.push(t); }

  // Links
  const links: string[] = [];
  const lRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lm; while ((lm = lRe.exec(html)) && links.length < 30) { links.push(`${lm[2]!.replace(/<[^>]*>/g, '').trim()} → ${lm[1]}`); }

  // Forms
  const forms: string[] = [];
  const fRe = /<form[^>]*>([\s\S]*?)<\/form>/gi;
  let fm; while ((fm = fRe.exec(html)) && forms.length < 10) { const inputs = fm[1]!.match(/name=["']([^"']+)/gi)?.map(m => m.slice(6, -1)) || []; if (inputs.length) forms.push(inputs.join(', ')); }

  // JS bundles (sniffed for keywords + API URLs)
  const scriptUrls: string[] = [];
  const sRe = /<script[^>]*src=["']([^"']+)["']/gi;
  let sm; while ((sm = sRe.exec(html)) && scriptUrls.length < 3) { try { scriptUrls.push(new URL(sm[1]!, url).toString()); } catch {} }
  const bundles = await Promise.all(scriptUrls.map(fetchPage));
  const jsText = bundles.join('\n');
  const keywords = ['swap', 'stake', 'deposit', 'withdraw', 'borrow', 'lend', 'bridge', 'claim', 'vote', 'transfer', 'approve', 'mint', 'connect'];
  const scriptHints = keywords.filter(k => (html + jsText).toLowerCase().includes(k));

  // SPA recovery: inline JSON + API endpoints + live samples (fixes the empty-shell case).
  const embeddedJson = extractEmbeddedJson(html);
  const apiEndpoints = discoverApiEndpoints(html, bundles, url, embeddedJson);
  const apiSamples = await probeApiEndpoints(apiEndpoints);

  return { url, title, description: desc, text, headings, buttons, links, forms, scriptHints, apiEndpoints, apiSamples, embeddedJson };
}

// ─── SPA discovery helpers (same shape as src/lib/scanner.ts) ────────────────
const MAX_API_ENDPOINTS = 8;
const MAX_API_PROBES = 3;
const PROBE_TIMEOUT_MS = 3500;
const PROBE_BODY_LIMIT = 2048;

function safeHost(u: string): string | undefined { try { return new URL(u).hostname || undefined; } catch { return undefined; } }

function extractEmbeddedJson(html: string): object[] {
  const out: object[] = [];
  const re = /<script\b[^>]*?(?:type=["'](?:application\/(?:ld\+)?json|application\/json)["'][^>]*?(?:\bid=["']([^"']+)["'])?|\bid=["']__NEXT_DATA__["'][^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 6) {
    const raw = m[2]?.trim(); if (!raw) continue;
    try { const p = JSON.parse(raw); if (p && typeof p === 'object') out.push(p); } catch {}
  }
  const stateRe = /\bwindow\.(?:__NUXT__|__INITIAL_STATE__|__APOLLO_STATE__)\s*=\s*(\{[\s\S]*?\});/g;
  let sm: RegExpExecArray | null;
  while ((sm = stateRe.exec(html)) && out.length < 6) {
    try { const p = JSON.parse(sm[1]!); if (p && typeof p === 'object') out.push(p); } catch {}
  }
  return out;
}

function discoverApiEndpoints(html: string, bundles: string[], baseUrl: string, embedded: object[]): ApiEndpoint[] {
  const out = new Map<string, ApiEndpoint>();
  const push = (raw: string, method: string, source: string) => {
    if (!raw) return;
    let resolved: URL;
    try { resolved = new URL(raw, baseUrl); } catch { return; }
    if (!/^https?:$/.test(resolved.protocol)) return;
    const host = resolved.hostname;
    // SSRF guard: only block private/loopback/link-local. Public cross-origin
    // APIs (api.vercel.app, *.amazonaws.com, third-party CDNs) are allowed —
    // SPAs routinely fetch from them and that's where the live data lives.
    if (/^(?:127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|localhost$)/i.test(host)) return;
    if (host === '::1' || host === '[::1]') return;
    if (/\.(?:js|css|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|map)(?:\?|$)/i.test(resolved.pathname)) return;
    const key = `${method}|${resolved.toString()}`;
    if (!out.has(key)) out.set(key, { url: resolved.toString(), method, source });
  };
  const corpus = [html, ...bundles].join('\n');
  const fetchRe = /\bfetch\s*\(\s*["'`]([^"'`]+)["'`](?:[^)]*?method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`])?/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fetchRe.exec(corpus))) push(fm[1]!, fm[2] || 'GET', 'js-bundle');
  const axiosRe = /\baxios\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
  let am: RegExpExecArray | null;
  while ((am = axiosRe.exec(corpus))) push(am[2]!, am[1]!.toUpperCase(), 'js-bundle');
  const baseRe = /(?:baseURL|apiURL|apiUrl|endpoint|API_URL|api_url)["']?\s*[:=]\s*["'`]([^"'`]+)["'`]/g;
  let bm: RegExpExecArray | null;
  while ((bm = baseRe.exec(corpus))) push(bm[1]!, 'GET', 'js-bundle');
  const jsonStr = JSON.stringify(embedded).slice(0, 200000);
  const urlRe = /["'](https?:\/\/[^"'\s)]+|\/(?:api|v\d+|graphql)\/[^"'\s)]+)["']/gi;
  let um: RegExpExecArray | null;
  while ((um = urlRe.exec(jsonStr))) push(um[1]!, 'GET', 'next-data');
  return [...out.values()].slice(0, MAX_API_ENDPOINTS);
}

async function probeApiEndpoints(endpoints: ApiEndpoint[]): Promise<ApiSample[]> {
  const candidates = endpoints.filter(e => e.method === 'GET').slice(0, MAX_API_PROBES);
  const probes = candidates.map(async (e): Promise<ApiSample | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(e.url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 hypermove-crawler/0.3', accept: 'application/json,text/plain;q=0.8,*/*;q=0.5' }, redirect: 'follow' });
      const ct = res.headers.get('content-type') ?? '';
      const raw = (await res.text()).slice(0, PROBE_BODY_LIMIT * 4);
      let bodyKeys: string[] | undefined;
      let bodyPreview = raw.slice(0, PROBE_BODY_LIMIT);
      if (/json/i.test(ct)) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            bodyKeys = Array.isArray(parsed) ? ['<array>'] : Object.keys(parsed).slice(0, 20);
            bodyPreview = JSON.stringify(parsed).slice(0, PROBE_BODY_LIMIT);
          }
        } catch {}
      }
      return { url: e.url, method: e.method, status: res.status, contentType: ct, bodyPreview, bodyKeys };
    } catch { return null; }
    finally { clearTimeout(timer); }
  });
  return (await Promise.all(probes)).filter((x): x is ApiSample => x !== null);
}

async function fetchPage(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 hypermove-crawler/0.2' }, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return '';
    return (await res.text()).slice(0, 5 * 1024 * 1024);
  } catch { return ''; }
}

function formatCrawlForLlm(crawl: CrawlData): string {
  const s: string[] = [];
  s.push(`## URL: ${crawl.url}`);
  s.push(`## Title: ${crawl.title}`);
  if (crawl.description) s.push(`## Description: ${crawl.description}`);
  if (crawl.headings.length) s.push(`## Headings:\n${crawl.headings.map(h => `- ${h}`).join('\n')}`);
  s.push(`## Page text:\n${crawl.text.slice(0, 4000)}`);
  if (crawl.buttons.length) s.push(`## Buttons:\n${crawl.buttons.map(b => `- ${b}`).join('\n')}`);
  if (crawl.links.length) s.push(`## Links:\n${crawl.links.slice(0, 20).map(l => `- ${l}`).join('\n')}`);
  if (crawl.forms.length) s.push(`## Forms (field names):\n${crawl.forms.map(f => `- ${f}`).join('\n')}`);
  if (crawl.apiEndpoints.length) s.push(`## API endpoints (discovered):\n${crawl.apiEndpoints.map(e => `- ${e.method} ${e.url}  [${e.source}]`).join('\n')}`);
  if (crawl.apiSamples.length) s.push(`## API live samples (use these as the real data source for tools):\n${crawl.apiSamples.map(x => `- ${x.method} ${x.url} → ${x.status} ${x.contentType}${x.bodyKeys?.length ? `  keys=[${x.bodyKeys.join(', ')}]` : ''}\n  body: ${x.bodyPreview}`).join('\n\n')}`);
  if (crawl.embeddedJson.length) s.push(`## Embedded JSON (SSR/Next/Nuxt):\n${JSON.stringify(crawl.embeddedJson).slice(0, 3000)}`);
  if (crawl.scriptHints.length) s.push(`## JS keywords: ${crawl.scriptHints.join(', ')}`);
  return s.join('\n\n');
}

// ─── LLM call ────────────────────────────────────────────────────────────────

async function callLlm(content: string): Promise<string> {
  const provider = process.env.LLM_PROVIDER || 'bedrock';

  if (provider === 'bedrock') {
    const apiKey = process.env.BEDROCK_API_KEY;
    if (!apiKey) throw new Error('BEDROCK_API_KEY not set');
    const region = process.env.BEDROCK_REGION || 'us-east-1';
    const model = process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const res = await fetch(`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 4000, messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n---\n${content.slice(0, 15000)}` }] }),
    });
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text || '';
  }

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514', max_tokens: 4000, messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n---\n${content.slice(0, 15000)}` }] }),
    });
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text || '';
  }

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o', max_tokens: 4000, messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n---\n${content.slice(0, 15000)}` }] }),
    });
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || '';
  }

  throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url || '/';

  // Health
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider: process.env.LLM_PROVIDER || 'bedrock' }));
    return;
  }

  // GET /quota?wallet=0x...
  if (req.method === 'GET' && url.startsWith('/quota')) {
    const params = new URL(url, `http://localhost:${PORT}`).searchParams;
    const wallet = params.get('wallet');
    if (!wallet) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing wallet' })); return; }
    try {
      const q = await getQuota(wallet);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(q));
    } catch { res.writeHead(500); res.end(JSON.stringify({ error: 'DB error' })); }
    return;
  }

  // POST /quota/consume — decrement 1 free scan
  if (req.method === 'POST' && url === '/quota/consume') {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body.wallet) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing wallet' })); return; }
    const allowed = await consumeQuota(body.wallet);
    if (!allowed) { res.writeHead(402); res.end(JSON.stringify({ error: 'quota_exhausted' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /upgrade — verify payment tx + upgrade tier (supports native BTC & ERC-20)
  if (req.method === 'POST' && url === '/upgrade') {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body.wallet || !body.txHash) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing wallet or txHash' })); return; }
    try {
      // Check duplicate txHash
      if (dbPool) {
        const { rows } = await dbPool.query(`SELECT tx_hash FROM hypermove_used_tx_hashes WHERE tx_hash = $1`, [body.txHash.toLowerCase()]);
        if (rows.length > 0) { res.writeHead(400); res.end(JSON.stringify({ error: 'Transaction already used' })); return; }
      }

      // Get receipt first (confirms tx succeeded)
      const receipt = await viemClient.getTransactionReceipt({ hash: body.txHash as `0x${string}` });
      if (!receipt || receipt.status !== 'success') { res.writeHead(400); res.end(JSON.stringify({ error: 'Transaction failed or not confirmed' })); return; }

      if (PAYMENT.useNative) {
        // --- Native BTC verification ---
        const tx = await viemClient.getTransaction({ hash: body.txHash as `0x${string}` });
        if (!tx) { res.writeHead(400); res.end(JSON.stringify({ error: 'Transaction not found' })); return; }
        if (tx.from.toLowerCase() !== body.wallet.toLowerCase()) { res.writeHead(400); res.end(JSON.stringify({ error: 'Not from your wallet' })); return; }
        if (!tx.to || tx.to.toLowerCase() !== PAYMENT.treasury.toLowerCase()) { res.writeHead(400); res.end(JSON.stringify({ error: 'Not to treasury' })); return; }
        if (tx.value < BigInt(PAYMENT.amountWei)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Insufficient amount' })); return; }
      } else {
        // --- ERC-20 token verification ---
        const transferLog = receipt.logs.find(log => log.address.toLowerCase() === PAYMENT.token.toLowerCase());
        if (!transferLog) { res.writeHead(400); res.end(JSON.stringify({ error: 'No token transfer found in tx' })); return; }
        const decoded = decodeEventLog({
          abi: [{ type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }],
          data: transferLog.data, topics: transferLog.topics,
        });
        const from = (decoded.args.from as string).toLowerCase();
        const to = (decoded.args.to as string).toLowerCase();
        const value = decoded.args.value as bigint;
        if (from !== body.wallet.toLowerCase()) { res.writeHead(400); res.end(JSON.stringify({ error: 'Not from your wallet' })); return; }
        if (to !== PAYMENT.treasury.toLowerCase()) { res.writeHead(400); res.end(JSON.stringify({ error: 'Not to treasury' })); return; }
        if (value < parseUnits(PAYMENT.amount, PAYMENT.tokenDecimals)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Insufficient amount' })); return; }
      }

      // All checks passed — upgrade + save txHash
      await upgradeToProTier(body.wallet);
      if (dbPool) { await dbPool.query(`INSERT INTO hypermove_used_tx_hashes (tx_hash, wallet_address) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [body.txHash.toLowerCase(), body.wallet.toLowerCase()]); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tier: 'pro', expiresIn: '30 days' }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: 'Verify failed', detail: (err as Error).message })); }
    return;
  }

  // Hosted MCP: GET /<wallet>/<slug> → manifest, POST /<wallet>/<slug> → JSON-RPC
  const mcpMatch = url.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (mcpMatch) {
    const [, wallet, slug] = mcpMatch;
    await handleHostedMcp(req, res, wallet!, slug!);
    return;
  }

  // POST /scan → full pipeline: crawl + LLM + generate
  if (req.method === 'POST' && (url === '/scan' || url === '/api/scan')) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { url?: string; wallet?: string; host?: string };
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

    if (!body.url) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing url' })); return; }

    try {
      // 1. Crawl
      const crawlData = await crawlUrl(body.url);

      // 2. LLM analyze
      const content = formatCrawlForLlm(crawlData);
      const raw = await callLlm(content);
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      let tools: Array<{ name: string; description: string; inputSchema?: unknown; endpoint?: string; method?: string }> = [];
      if (jsonMatch) {
        try { tools = JSON.parse(jsonMatch[0]); }
        catch { /* malformed/truncated — auto-augment below will still emit live read-tools */ }
      }
      // Auto-bind a probed endpoint when the LLM forgot to add one — keeps tools live by default.
      const fallbackEndpoint = crawlData.apiSamples[0]?.url ?? crawlData.apiEndpoints[0]?.url;
      const cleanTools = tools.slice(0, 15).map(t => ({
        name: String(t.name).replace(/\W+/g, '_').toLowerCase().slice(0, 64),
        description: t.description || t.name,
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        ...(t.endpoint || fallbackEndpoint ? { endpoint: t.endpoint || fallbackEndpoint } : {}),
        ...(t.method ? { method: String(t.method).toUpperCase() } : (t.endpoint || fallbackEndpoint ? { method: 'GET' } : {})),
        serverCompatible: true,
      }));

      // Auto-augment: append one read-tool per probed API endpoint the LLM
      // didn't bind. Guarantees the agent always has a live-data path even
      // if the LLM only emitted action tools or buried values in descriptions.
      const llmBound = new Set(cleanTools.map(t => (t as { endpoint?: string }).endpoint).filter(Boolean));
      for (const sample of crawlData.apiSamples || []) {
        if (cleanTools.length >= 15) break;
        if (llmBound.has(sample.url)) continue;
        const slug = toolNameFromUrl(sample.url);
        if (!slug) continue;
        const name = `read_${slug}`.slice(0, 64);
        if (cleanTools.some(t => t.name === name)) continue;
        cleanTools.push({
          name,
          description: `Live GET ${sample.url} — returns current ${(sample.bodyKeys ?? []).slice(0, 4).join('/') || 'data'} from the source API`,
          inputSchema: { type: 'object', properties: {} },
          endpoint: sample.url,
          method: 'GET',
          serverCompatible: true,
        });
      }

      // 3. Generate manifest
      const hostname = new URL(body.url).hostname.replace(/^www\./, '');
      const slug = `${hostname}-mcp`.replace(/[^a-z0-9-]/g, '-');
      // Host resolution priority (request-inferred → self-configuring):
      //   1. body.host                — explicit caller override
      //   2. process.env.MCP_HOST_URL — deploy-time override (rarely needed)
      //   3. x-forwarded-host + proto — when behind a reverse proxy (nginx, etc.)
      //   4. req.headers.host         — direct connection (e.g. localhost:3001)
      //   5. http://localhost:${PORT} — last-resort dev fallback
      //
      // The agent will call back at the same URL it used to reach us, so the
      // request itself is the source of truth. No env config required for the
      // common case — local dev returns localhost, prod returns prod, etc.
      const baseHost = resolveHostBase(req, body, PORT);
      const walletAddr = body.wallet || '0x0000000000000000000000000000000000000000';
      const manifest = {
        name: slug,
        version: '0.1.0',
        description: `Agent-callable tools extracted from ${body.url}`,
        tools: cleanTools,
        generatedAt: new Date().toISOString(),
        sourceUrl: body.url,
      };

      // 4. Generate MCP config
      const mcpConfig = {
        mcpServers: {
          [slug]: {
            url: `${baseHost}/${walletAddr}/${slug}`,
            transport: 'http',
            description: manifest.description,
            tools: cleanTools.map(t => t.name),
          },
        },
      };

      // 5. Register for hosting
      mcpStore.set(`${walletAddr}/${slug}`, manifest);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        manifest,
        mcpConfig,
        crawlData: {
          url: crawlData.url,
          title: crawlData.title,
          toolCount: cleanTools.length,
          // Surfaced so the FE/agent can see what was discovered and why a tool
          // was (or wasn't) bound to a live endpoint. Full sample bodies omitted
          // for payload size; bodyKeys hint at the JSON shape.
          apiEndpoints: (crawlData.apiEndpoints || []).map(e => ({ url: e.url, method: e.method, source: e.source })),
          apiSamples: (crawlData.apiSamples || []).map(s => ({ url: s.url, status: s.status, contentType: s.contentType, bodyKeys: s.bodyKeys ?? [] })),
        },
      }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Scan failed', detail: (err as Error).message }));
    }
    return;
  }

  // POST / or /api/llm → LLM analyze only (legacy)
  if (req.method === 'POST' && (url === '/' || url === '/api/llm')) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { content?: string };
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

    if (!body.content) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing content' })); return; }

    try {
      const raw = await callLlm(body.content);
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tools: [] })); return; }

      let tools: Array<{ name: string; description: string; inputSchema?: unknown }> = [];
      try { tools = JSON.parse(jsonMatch[0]); }
      catch { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tools: [] })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        tools: tools.slice(0, 15).map(t => ({
          name: String(t.name).replace(/\W+/g, '_').toLowerCase().slice(0, 64),
          description: t.description || t.name,
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
        })),
      }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'LLM call failed', detail: (err as Error).message }));
    }
    return;
  }

  // POST /register → save MCP for hosted serving
  if (req.method === 'POST' && url === '/register') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { wallet?: string; slug?: string; manifest?: unknown };
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    if (!body.wallet || !body.slug || !body.manifest) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing wallet, slug, or manifest' })); return; }
    mcpStore.set(`${body.wallet}/${body.slug}`, body.manifest);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url: `/${body.wallet}/${body.slug}` }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ─── In-memory MCP store (replace with DB for production) ────────────────────
const mcpStore = new Map<string, unknown>();

async function handleHostedMcp(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, wallet: string, slug: string) {
  const key = `${wallet}/${slug}`;
  const manifest = mcpStore.get(key) as { name?: string; version?: string; tools?: Array<{ name: string; description: string; inputSchema: unknown }> } | undefined;

  if (!manifest) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'MCP not found', path: `/${wallet}/${slug}` }));
    return;
  }

  // GET → return manifest
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(manifest, null, 2));
    return;
  }

  // POST → JSON-RPC
  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { jsonrpc: string; id: any; method: string; params?: any };
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const tools = manifest.tools || [];
    let result: unknown;
    switch (body.method) {
      case 'initialize':
        result = { protocolVersion: '2024-11-05', serverInfo: { name: manifest.name, version: manifest.version || '0.1.0' }, capabilities: { tools: {} } };
        break;
      case 'tools/list':
        result = { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
        break;
      case 'tools/call': {
        const name = body.params?.name;
        const args = body.params?.arguments ?? {};
        const tool = tools.find(t => t.name === name) as (typeof tools[number] & { endpoint?: string; method?: string }) | undefined;
        if (!tool) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Unknown tool: ${name}` } })); return; }
        result = await callLiveTool(tool, args);
        break;
      }
      default:
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Unknown method: ${body.method}` } }));
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    return;
  }

  res.writeHead(405); res.end('Method not allowed');
}

/** Resolve the public base URL to embed in the returned MCP config.
 *  Single source of truth — the agent will dial this exact URL.
 *  Priority: body.host → MCP_HOST_URL env → forwarded-host (proxy) → req.headers.host → localhost. */
function resolveHostBase(req: import('node:http').IncomingMessage, body: { host?: string }, fallbackPort: number): string {
  const trim = (s: string) => s.replace(/\/+$/, '');
  if (body.host) return trim(String(body.host));
  if (process.env.MCP_HOST_URL) return trim(process.env.MCP_HOST_URL);
  const xfHost = (req.headers['x-forwarded-host'] as string | undefined) || '';
  const xfProto = (req.headers['x-forwarded-proto'] as string | undefined) || '';
  const directHost = (req.headers.host as string | undefined) || '';
  const host = xfHost || directHost;
  if (host) {
    const encrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
    const proto = xfProto.split(',')[0]!.trim() || (encrypted ? 'https' : 'http');
    return trim(`${proto}://${host}`);
  }
  return `http://localhost:${fallbackPort}`;
}

/** Derive a stable snake_case tool name from a URL pathname (last two path segments). */
function toolNameFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).slice(-2).join('_');
    const host = u.hostname.replace(/^www\./, '').split('.')[0]!;
    return (path || host).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  } catch { return ''; }
}

/** Live proxy used by hosted MCP — replaces the previous {"status":"stub"} response. */
async function callLiveTool(tool: { name: string; endpoint?: string; method?: string }, args: Record<string, unknown>): Promise<unknown> {
  if (!tool.endpoint) {
    return { content: [{ type: 'text', text: JSON.stringify({ tool: tool.name, args, status: 'no endpoint bound — extend this hosted tool' }) }], isError: false };
  }
  const method = (tool.method || 'GET').toUpperCase();
  let url = tool.endpoint;
  const init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal } = {
    method,
    headers: { 'user-agent': 'hypermove-mcp/0.3', accept: 'application/json,text/plain;q=0.8,*/*;q=0.5' },
  };
  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(args ?? {})) if (v != null) qs.set(k, String(v));
    if ([...qs.keys()].length) url += (url.includes('?') ? '&' : '?') + qs.toString();
  } else {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args ?? {});
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const ct = res.headers.get('content-type') ?? '';
    const text = (await res.text()).slice(0, 32 * 1024);
    return { content: [{ type: 'text', text }], isError: !res.ok, _meta: { status: res.status, contentType: ct, url } };
  } catch (e: any) {
    return { content: [{ type: 'text', text: 'fetch failed: ' + (e?.message || String(e)) }], isError: true };
  } finally { clearTimeout(timer); }
}

server.listen(PORT, () => {
  console.log(`LLM service running on port ${PORT}`);
  console.log(`Provider: ${process.env.LLM_PROVIDER || 'bedrock'}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
