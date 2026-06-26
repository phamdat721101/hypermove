/**
 * src/lib/scanner.ts
 * ------------------
 * Crawl any URL → extract ALL data → send to LLM → get MCP tools back.
 *
 * Flow:
 *   1. Fetch HTML + JS bundles from URL
 *   2. Parse DOM → extract EVERYTHING (text, forms, buttons, links, tables, JSON-LD, metadata)
 *   3. Package as "crawl data"
 *   4. Send crawl data to /api/llm → LLM analyzes → returns tools JSON
 *   5. Generate MCP manifest + server from tools
 */

import { parseHTML } from 'linkedom';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GenericTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CrawlData {
  url: string;
  title: string;
  description: string;
  text: string;
  forms: FormSummary[];
  buttons: string[];
  links: Array<{ href: string; text: string; internal: boolean }>;
  tables: Array<{ caption?: string; columns: string[]; rowCount: number }>;
  jsonLd: object[];
  metadata: Record<string, string>;
  headings: string[];
  scriptHints: string[];
}

export interface FormSummary {
  id?: string;
  action?: string;
  method?: string;
  fields: Array<{ name: string; type: string; required: boolean; placeholder?: string }>;
  label?: string;
}

export interface ScanResult {
  url: string;
  scannedAt: string;
  durationMs: number;
  crawlData: CrawlData;
  tools: GenericTool[];
}

export interface MCPManifest {
  name: string;
  version: string;
  description: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; serverCompatible: boolean }>;
  chains: number[];
  generatedAt: string;
  sourceUrl: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_BUNDLES = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

// ─── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 hypermove-crawler/0.2' },
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const text = await res.text();
    return text.slice(0, MAX_BYTES);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function extractScriptUrls(html: string, base: string): string[] {
  const urls: string[] = [];
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try { urls.push(new URL(m[1]!, base).toString()); } catch {}
  }
  return urls.slice(0, MAX_BUNDLES);
}

// ─── Crawl: Extract EVERYTHING from HTML ─────────────────────────────────────

function crawlHtml(html: string, url: string, jsBundles: string[]): CrawlData {
  let document: Document;
  try { ({ document } = parseHTML(html) as { document: Document }); } catch {
    return emptyCrawl(url);
  }

  const baseHost = safeHostname(url);

  // Title + metadata
  const title = (document.querySelector('title')?.textContent ?? '').trim();
  const description = document.querySelector('meta[name="description"]')?.getAttribute('content')
    ?? document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '';

  const metadata: Record<string, string> = {};
  for (const meta of document.querySelectorAll('meta[name], meta[property]')) {
    const key = meta.getAttribute('name') || meta.getAttribute('property') || '';
    const val = meta.getAttribute('content') || '';
    if (key && val) metadata[key] = val.slice(0, 200);
  }

  // Full visible text
  const text = (document.body?.textContent ?? '')
    .replace(/\s+/g, ' ').trim().slice(0, 8000);

  // Headings
  const headings: string[] = [];
  for (const h of [...document.querySelectorAll('h1, h2, h3, h4')].slice(0, 30)) {
    const t = (h.textContent ?? '').trim();
    if (t.length > 2 && t.length < 100) headings.push(t);
  }

  // Forms
  const forms: FormSummary[] = [];
  for (const form of [...document.querySelectorAll('form')].slice(0, 20)) {
    const fields: FormSummary['fields'] = [];
    for (const f of form.querySelectorAll('input, select, textarea')) {
      const name = f.getAttribute('name') ?? '';
      if (!name) continue;
      const tag = f.tagName.toLowerCase();
      fields.push({
        name,
        type: tag === 'input' ? f.getAttribute('type') ?? 'text' : tag,
        required: f.hasAttribute('required'),
        placeholder: f.getAttribute('placeholder') ?? undefined,
      });
    }
    forms.push({
      id: form.getAttribute('id') ?? undefined,
      action: resolveUrl(form.getAttribute('action'), url),
      method: (form.getAttribute('method') ?? 'GET').toUpperCase(),
      fields,
      label: form.getAttribute('aria-label') ?? undefined,
    });
  }

  // Buttons
  const buttons: string[] = [];
  for (const btn of [...document.querySelectorAll('button, [role="button"]')].slice(0, 30)) {
    const t = (btn.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (t.length > 1) buttons.push(t);
  }

  // Links
  const links: CrawlData['links'] = [];
  for (const a of [...document.querySelectorAll('a[href]')].slice(0, 50)) {
    const raw = a.getAttribute('href') ?? '';
    if (!raw || /^(?:#|mailto:|javascript:|tel:)/.test(raw)) continue;
    const resolved = resolveUrl(raw, url) ?? raw;
    const linkHost = safeHostname(resolved);
    links.push({
      href: resolved,
      text: (a.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
      internal: !!linkHost && !!baseHost && linkHost === baseHost,
    });
  }

  // Tables
  const tables: CrawlData['tables'] = [];
  for (const tbl of [...document.querySelectorAll('table')].slice(0, 10)) {
    const caption = tbl.querySelector('caption')?.textContent?.trim() || undefined;
    const columns = [...tbl.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim()).filter(Boolean);
    const rowCount = tbl.querySelectorAll('tbody tr').length || tbl.querySelectorAll('tr').length;
    tables.push({ caption, columns, rowCount });
  }

  // JSON-LD
  const jsonLd: object[] = [];
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 10)) {
    try {
      const parsed = JSON.parse(script.textContent ?? '');
      if (parsed && typeof parsed === 'object') jsonLd.push(parsed);
    } catch {}
  }

  // JS bundle hints (function names, keywords from minified JS)
  const scriptHints: string[] = [];
  const combined = jsBundles.join(' ');
  const keywords = ['swap', 'stake', 'deposit', 'withdraw', 'borrow', 'lend', 'bridge', 'claim', 'vote', 'transfer', 'approve', 'mint', 'burn', 'connect', 'disconnect'];
  for (const kw of keywords) {
    if (combined.toLowerCase().includes(kw)) scriptHints.push(kw);
  }

  return { url, title, description, text, forms, buttons, links, tables, jsonLd, metadata, headings, scriptHints };
}

function emptyCrawl(url: string): CrawlData {
  return { url, title: '', description: '', text: '', forms: [], buttons: [], links: [], tables: [], jsonLd: [], metadata: {}, headings: [], scriptHints: [] };
}

function resolveUrl(maybeRel: string | null | undefined, base: string): string | undefined {
  if (!maybeRel) return undefined;
  try { return new URL(maybeRel, base).toString(); } catch { return undefined; }
}

function safeHostname(url: string): string | undefined {
  try { return new URL(url).hostname || undefined; } catch { return undefined; }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Main scan function:
 * 1. Crawl URL → extract all data
 * 2. Send to LLM (/api/llm) → get tools
 * 3. Return result
 */
export async function scanUrl(url: string): Promise<ScanResult> {
  const start = Date.now();

  // Fetch HTML + JS
  const html = await fetchText(url);
  if (!html) {
    return { url, scannedAt: new Date().toISOString(), durationMs: Date.now() - start, crawlData: emptyCrawl(url), tools: [] };
  }

  const scriptUrls = extractScriptUrls(html, url);
  const bundles = await Promise.all(scriptUrls.map(fetchText));

  // Crawl everything
  const crawlData = crawlHtml(html, url, bundles.filter(Boolean));

  // Send to LLM for analysis
  const tools = await callLlmBackend(crawlData);

  // If LLM returns nothing, generate basic tools from crawl data as fallback
  const finalTools = tools.length > 0 ? tools : fallbackTools(crawlData);

  return { url, scannedAt: new Date().toISOString(), durationMs: Date.now() - start, crawlData, tools: finalTools };
}

/**
 * Call LLM service (hosted on Lightsail). LLM does all the analysis.
 * Configure via env: LLM_API_URL=http://<lightsail-ip>:3001
 */
async function callLlmBackend(crawl: CrawlData): Promise<GenericTool[]> {
  const llmUrl = process.env.LLM_API_URL || process.env.NEXT_PUBLIC_LLM_API_URL;
  if (!llmUrl) return []; // No LLM configured, skip

  try {
    const content = formatCrawlForLlm(crawl);
    const res = await fetch(llmUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { tools?: GenericTool[] };
    return data.tools || [];
  } catch {
    return [];
  }
}

/** Format crawl data as structured text for LLM consumption. */
function formatCrawlForLlm(crawl: CrawlData): string {
  const sections: string[] = [];

  sections.push(`## URL: ${crawl.url}`);
  sections.push(`## Title: ${crawl.title}`);
  if (crawl.description) sections.push(`## Description: ${crawl.description}`);

  if (crawl.headings.length) sections.push(`## Headings:\n${crawl.headings.map(h => `- ${h}`).join('\n')}`);

  sections.push(`## Page text (condensed):\n${crawl.text.slice(0, 4000)}`);

  if (crawl.forms.length) {
    sections.push(`## Forms:\n${crawl.forms.map(f => `- ${f.method} ${f.action || '/'} [${f.fields.map(x => `${x.name}:${x.type}${x.required ? '!' : ''}`).join(', ')}]`).join('\n')}`);
  }

  if (crawl.buttons.length) sections.push(`## Buttons:\n${crawl.buttons.map(b => `- ${b}`).join('\n')}`);

  if (crawl.links.length) {
    const internal = crawl.links.filter(l => l.internal);
    const external = crawl.links.filter(l => !l.internal).slice(0, 10);
    if (internal.length) sections.push(`## Internal links:\n${internal.map(l => `- ${l.text} → ${l.href}`).join('\n')}`);
    if (external.length) sections.push(`## External links:\n${external.map(l => `- ${l.text} → ${l.href}`).join('\n')}`);
  }

  if (crawl.tables.length) sections.push(`## Tables:\n${crawl.tables.map(t => `- ${t.caption || 'table'}: [${t.columns.join(', ')}] (${t.rowCount} rows)`).join('\n')}`);

  if (crawl.jsonLd.length) sections.push(`## Structured data (JSON-LD):\n${JSON.stringify(crawl.jsonLd).slice(0, 2000)}`);

  if (crawl.scriptHints.length) sections.push(`## JS keywords detected: ${crawl.scriptHints.join(', ')}`);

  if (Object.keys(crawl.metadata).length) {
    const meta = Object.entries(crawl.metadata).slice(0, 10).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    sections.push(`## Metadata:\n${meta}`);
  }

  return sections.join('\n\n');
}

/** Fallback when LLM is unavailable — basic tools from crawl data. */
function fallbackTools(crawl: CrawlData): GenericTool[] {
  const tools: GenericTool[] = [];

  // Forms → tools
  for (const form of crawl.forms) {
    const name = form.id || form.label || (form.action ? form.action.replace(/\W+/g, '_').slice(0, 50) : null);
    if (!name || form.fields.length === 0) continue;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const f of form.fields) {
      properties[f.name] = { type: f.type === 'number' ? 'number' : 'string', ...(f.placeholder ? { description: f.placeholder } : {}) };
      if (f.required) required.push(f.name);
    }
    tools.push({ name, description: form.label || `Form: ${form.method} ${form.action || '/'}`, inputSchema: { type: 'object', properties, required } });
  }

  // Headings as read tools (for informational pages)
  if (tools.length === 0 && crawl.headings.length > 0) {
    tools.push({
      name: 'read_page',
      description: `Read: ${crawl.title || crawl.url}. Sections: ${crawl.headings.slice(0, 5).join(', ')}`,
      inputSchema: { type: 'object', properties: { section: { type: 'string', description: 'Section to read' } } },
    });
  }

  return tools;
}

// ─── MCP Generation ──────────────────────────────────────────────────────────

export function generateMCPManifest(scan: ScanResult, opts?: { name?: string }): MCPManifest {
  const hostname = new URL(scan.url).hostname.replace(/^www\./, '');
  const name = opts?.name || `${hostname}-mcp`;

  return {
    name,
    version: '0.1.0',
    description: `Agent-callable tools extracted from ${scan.url}`,
    tools: scan.tools.map((t) => ({ ...t, serverCompatible: true })),
    chains: [],
    generatedAt: new Date().toISOString(),
    sourceUrl: scan.url,
  };
}

export function emitMCPServer(manifest: MCPManifest): string {
  const toolsJson = JSON.stringify(manifest.tools, null, 2);
  const manifestJson = JSON.stringify(manifest, null, 2);

  return `import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 3002);
const MANIFEST = ${manifestJson};
const TOOLS = ${toolsJson};

interface JsonRpcReq { jsonrpc: '2.0'; id: any; method: string; params?: any; }

function ok(id: any, result: unknown) { return JSON.stringify({ jsonrpc: '2.0', id, result }); }
function err(id: any, code: number, msg: string) { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: msg } }); }

async function handle(body: JsonRpcReq) {
  switch (body.method) {
    case 'initialize':
      return ok(body.id, { protocolVersion: '2024-11-05', serverInfo: { name: MANIFEST.name, version: MANIFEST.version }, capabilities: { tools: {} } });
    case 'tools/list':
      return ok(body.id, { tools: TOOLS.map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const name = body.params?.name;
      const args = body.params?.arguments ?? {};
      const tool = TOOLS.find((t: any) => t.name === name);
      if (!tool) return err(body.id, -32601, 'Unknown tool: ' + name);
      return ok(body.id, { content: [{ type: 'text', text: JSON.stringify({ tool: name, args, status: 'stub - implement handler here' }) }] });
    }
    default:
      return err(body.id, -32601, 'Unknown method: ' + body.method);
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, name: MANIFEST.name })); return; }
  if (req.method === 'GET' && req.url === '/.well-known/webmcp.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(MANIFEST, null, 2)); return; }
  if (req.method === 'POST') {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    let body: JsonRpcReq;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end(err(null, -32700, 'Parse error')); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(await handle(body)); return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('MCP Server running on port ' + PORT + ' · Tools: ' + TOOLS.length));
`;
}

export function generateMCPConfig(manifest: MCPManifest, host: string, wallet?: string): Record<string, unknown> {
  const base = host.startsWith('http') ? host : `http://${host}:3001`;
  const walletAddr = wallet || '0x0000000000000000000000000000000000000000';
  return {
    mcpServers: {
      [manifest.name]: {
        url: `${base}/${walletAddr}/${manifest.name}`,
        transport: 'http',
        description: manifest.description,
        tools: manifest.tools.map((t) => t.name),
      },
    },
  };
}
