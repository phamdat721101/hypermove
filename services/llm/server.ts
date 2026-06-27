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

const PORT = Number(process.env.PORT || 3001);

const SYSTEM_PROMPT = `You are analyzing a web page to extract user-callable actions as MCP tools.
Given the website's crawled data below, identify ALL actions a user can perform.
Return ONLY a JSON array of tools. Each tool must have:
- name: snake_case identifier
- description: 1 sentence explaining what the tool does
- inputSchema: JSON Schema object with properties and required fields

Focus on: forms, transactions, staking, swapping, deposits, withdrawals, claims, votes, purchases, bookings, searches, filtering.
Skip: pure navigation links, social media links, footer links, cookie banners.
For DeFi/Web3: extract main actions (stake, swap, lend, borrow, deposit, withdraw, bridge, claim).
For regular sites: extract forms, search, purchase flows, account actions.

Return 1-15 tools. Quality > quantity. Raw JSON array only, no markdown fences.`;

// ─── Crawl logic ─────────────────────────────────────────────────────────────

interface CrawlData { url: string; title: string; description: string; text: string; headings: string[]; buttons: string[]; links: string[]; forms: string[]; scriptHints: string[] }

async function crawlUrl(url: string): Promise<CrawlData> {
  const html = await fetchPage(url);
  if (!html) return { url, title: '', description: '', text: '', headings: [], buttons: [], links: [], forms: [], scriptHints: [] };

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

  // JS keyword hints
  const scriptUrls: string[] = [];
  const sRe = /<script[^>]*src=["']([^"']+)["']/gi;
  let sm; while ((sm = sRe.exec(html)) && scriptUrls.length < 3) { try { scriptUrls.push(new URL(sm[1]!, url).toString()); } catch {} }
  let jsText = '';
  for (const su of scriptUrls) { jsText += await fetchPage(su); }
  const keywords = ['swap', 'stake', 'deposit', 'withdraw', 'borrow', 'lend', 'bridge', 'claim', 'vote', 'transfer', 'approve', 'mint', 'connect'];
  const scriptHints = keywords.filter(k => (html + jsText).toLowerCase().includes(k));

  return { url, title, description: desc, text, headings, buttons, links, forms, scriptHints };
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
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 2000, messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n---\n${content.slice(0, 15000)}` }] }),
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
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514', max_tokens: 2000, messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n---\n${content.slice(0, 15000)}` }] }),
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
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o', max_tokens: 2000, messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n---\n${content.slice(0, 15000)}` }] }),
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
      let tools: Array<{ name: string; description: string; inputSchema?: unknown }> = [];
      if (jsonMatch) {
        tools = JSON.parse(jsonMatch[0]);
      }
      const cleanTools = tools.slice(0, 15).map(t => ({
        name: String(t.name).replace(/\W+/g, '_').toLowerCase().slice(0, 64),
        description: t.description || t.name,
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        serverCompatible: true,
      }));

      // 3. Generate manifest
      const hostname = new URL(body.url).hostname.replace(/^www\./, '');
      const slug = `${hostname}-mcp`.replace(/[^a-z0-9-]/g, '-');
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
      const mcpBaseUrl = process.env.MCP_HOST_URL || `http://localhost:${PORT}`;
      const mcpConfig = {
        mcpServers: {
          [slug]: {
            url: `${mcpBaseUrl}/${walletAddr}/${slug}`,
            transport: 'http',
            description: manifest.description,
            tools: cleanTools.map(t => t.name),
          },
        },
      };

      // 5. Register for hosting
      mcpStore.set(`${walletAddr}/${slug}`, manifest);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ manifest, mcpConfig, crawlData: { url: crawlData.url, title: crawlData.title, toolCount: cleanTools.length } }));
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

      const tools = JSON.parse(jsonMatch[0]) as Array<{ name: string; description: string; inputSchema?: unknown }>;
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
        const tool = tools.find(t => t.name === name);
        if (!tool) { result = undefined; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Unknown tool: ${name}` } })); return; }
        result = { content: [{ type: 'text', text: JSON.stringify({ tool: name, args, status: 'stub' }) }] };
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

server.listen(PORT, () => {
  console.log(`LLM service running on port ${PORT}`);
  console.log(`Provider: ${process.env.LLM_PROVIDER || 'bedrock'}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
