/**
 * src/lib/scanner.ts
 * ------------------
 * Lightweight URL scanner ported from web3-mcp/packages/scanner.
 * Fetches HTML + JS bundles, runs regex/address detectors, returns detected tools.
 *
 * WHY port instead of importing @webmcp/scanner directly:
 *   - hypermove is standalone Next.js, not a workspace member of web3-mcp
 *   - We only need the core detection logic (no LLM analyze, no Playwright)
 *   - Keeps bundle size minimal (~0 new deps, uses native fetch)
 *
 * FLOW:
 *   1. Fetch HTML from target URL
 *   2. Extract <script src="..."> URLs
 *   3. Fetch up to 5 JS bundles (max 5MB total)
 *   4. Concatenate all text into a "corpus"
 *   5. Run detector rules (regex patterns + contract addresses + npm imports)
 *   6. Detect wallet adapter, chains, and extract DOM forms as generic tools
 *   7. Return structured result
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DetectedPrimitive {
  name: string;
  detected: boolean;
  confidence: number;
  evidence: string[];
}

export interface GenericTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Structured data extracted from DOM — the "crawl data" layer. */
export interface DomFeatures {
  title: string;
  description?: string;
  ogType?: string;
  forms: FormSummary[];
  buttons: ButtonSummary[];
  links: LinkSummary[];
  inputsOutsideForm: { name: string; type: string; placeholder?: string }[];
  jsonLd: object[];
  tables: TableSummary[];
  semanticElements: Record<string, number>;
}

export interface FormField { name: string; type: string; required: boolean; placeholder?: string }
export interface FormSummary { id?: string; action?: string; method?: string; fields: FormField[]; ariaLabel?: string }
export interface ButtonSummary { text: string; ariaLabel?: string; dataAction?: string }
export interface LinkSummary { href: string; text: string; isInternal: boolean }
export interface TableSummary { caption?: string; columns: string[]; rowCount: number }

export interface ScanResult {
  url: string;
  scannedAt: string;
  durationMs: number;
  primitives: DetectedPrimitive[];
  walletAdapter: string;
  chains: number[];
  genericTools: GenericTool[];
  /** Structured crawl data from DOM parsing */
  domFeatures: DomFeatures;
}

export interface MCPManifest {
  name: string;
  version: string;
  description: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    serverCompatible: boolean;
  }>;
  chains: number[];
  walletAdapter: string;
  generatedAt: string;
  sourceUrl: string;
}

// ─── Detector Rules ──────────────────────────────────────────────────────────
// Ported from web3-mcp/packages/scanner/src/detectors.ts
// Each rule matches against the concatenated corpus of HTML + JS bundles.

interface DetectorRule {
  name: string;
  description: string;
  serverCompatible: boolean;
  weight?: number;
  anyOf: {
    addressesLower?: string[];
    patterns?: string[];
    imports?: string[];
  };
}

const DETECTORS: DetectorRule[] = [
  {
    name: 'wallet.connect',
    description: 'Connect a web3 wallet (MetaMask, WalletConnect, etc.)',
    serverCompatible: false,
    anyOf: {
      patterns: ['connectWallet', 'useConnect', 'web3Modal', 'wagmi.*connect', 'window\\.ethereum'],
      imports: ['wagmi', '@rainbow-me/rainbowkit', 'web3modal', '@walletconnect/sign-client', '@privy-io/react-auth'],
    },
  },
  {
    name: 'tx.send',
    description: 'Send an on-chain transaction',
    serverCompatible: false,
    anyOf: {
      patterns: ['sendTransaction', 'writeContract', 'useSendTransaction', 'eth_sendTransaction'],
      imports: ['viem', 'ethers', 'wagmi'],
    },
  },
  {
    name: 'swap.execute',
    description: 'Execute a token swap on a DEX',
    serverCompatible: false,
    anyOf: {
      patterns: ['swap', 'exactInputSingle', 'swapExactTokens', 'UniswapV[23]', 'PancakeRouter'],
      addressesLower: [
        '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap Universal Router
        '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 Router
        '0x10ed43c718714eb63d5aa57b78b54704e256024e', // PancakeSwap Router
      ],
      imports: ['@uniswap/sdk', '@uniswap/v3-sdk', '@pancakeswap/sdk'],
    },
  },
  {
    name: 'payment.send',
    description: 'Send a payment (ERC-20 transfer)',
    serverCompatible: false,
    anyOf: {
      patterns: ['transfer\\(', 'transferFrom', 'approve\\(', 'payment', 'payable'],
      imports: ['viem', 'ethers'],
    },
  },
  {
    name: 'payment.x402',
    description: 'Pay via HTTP 402 x402-USDC protocol',
    serverCompatible: true,
    anyOf: {
      patterns: ['x402', 'payment-required', 'WWW-Authenticate.*x402', 'fetchWithPayment'],
      imports: ['n-payment', '@phamnim/web3-webmcp'],
    },
  },
  {
    name: 'lend.deposit',
    description: 'Deposit collateral into a lending protocol',
    serverCompatible: false,
    anyOf: {
      patterns: ['supply\\(', 'deposit\\(', 'lend', 'aave.*pool', 'compound.*cToken'],
      addressesLower: [
        '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', // Aave V3 Pool (Ethereum)
      ],
      imports: ['@aave/contract-helpers', '@compound-finance/compound-js'],
    },
  },
  {
    name: 'nft.buy',
    description: 'Purchase an NFT from a marketplace',
    serverCompatible: false,
    anyOf: {
      patterns: ['fulfillOrder', 'buyNow', 'seaport', 'opensea', 'mintNFT', 'ERC721', 'ERC1155'],
      addressesLower: [
        '0x00000000000000adc04c56bf30ac9d3c0aaf14dc', // Seaport 1.5
      ],
      imports: ['@opensea/seaport-js', 'thirdweb'],
    },
  },
  {
    name: 'bridge.send',
    description: 'Bridge tokens cross-chain',
    serverCompatible: false,
    anyOf: {
      patterns: ['bridge', 'crossChain', 'layerZero', 'wormhole', 'chainId.*destination'],
      imports: ['@layerzerolabs/oft-evm', '@wormhole-foundation/sdk'],
    },
  },
  {
    name: 'stake.deposit',
    description: 'Stake tokens for yield/governance',
    serverCompatible: false,
    anyOf: {
      patterns: ['stake\\(', 'staking', 'validator', 'delegate\\(', 'unstake'],
      imports: ['@lido-sdk/constants'],
    },
  },
  {
    name: 'dao.vote',
    description: 'Vote on a governance proposal',
    serverCompatible: false,
    anyOf: {
      patterns: ['castVote', 'propose\\(', 'governance', 'snapshot', 'governor'],
      imports: ['@openzeppelin/contracts/governance'],
    },
  },
];

// ─── Wallet Adapter Detection ────────────────────────────────────────────────

const WALLET_ADAPTERS = [
  { name: 'wagmi', patterns: ['wagmi', 'useAccount', 'useConnect', 'createConfig.*wagmi'] },
  { name: 'rainbowkit', patterns: ['RainbowKitProvider', '@rainbow-me/rainbowkit'] },
  { name: 'walletconnect', patterns: ['WalletConnect', '@walletconnect/sign-client', 'walletconnect'] },
  { name: 'privy', patterns: ['PrivyProvider', '@privy-io', 'usePrivy'] },
  { name: 'web3modal', patterns: ['Web3Modal', 'web3modal'] },
];

// ─── Chain Detection ─────────────────────────────────────────────────────────

const CHAIN_HINTS: Record<number, string[]> = {
  1: ['mainnet', 'chainId.*:.*1[^0-9]', 'ethereum'],
  137: ['polygon', 'matic', 'chainId.*137'],
  42161: ['arbitrum', 'chainId.*42161'],
  10: ['optimism', 'chainId.*:.*10[^0-9]'],
  8453: ['base', 'chainId.*8453'],
  56: ['bsc', 'binance', 'chainId.*56[^0-9]'],
  43114: ['avalanche', 'avax', 'chainId.*43114'],
  250: ['fantom', 'chainId.*250'],
  2345: ['goat', 'chainId.*2345'],
  14: ['flare', 'chainId.*14[^0-9]'],
};

// ─── Core Logic ──────────────────────────────────────────────────────────────

import { parseHTML } from 'linkedom';

const MAX_BUNDLES = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

// ─── DOM Parser (crawl data) ─────────────────────────────────────────────────
// Parses HTML into structured DomFeatures. Uses linkedom (lightweight DOM).
// This is the "crawl data" that NIM mentioned — extracting components/data from HTML.

function emptyDomFeatures(): DomFeatures {
  return {
    title: '', forms: [], buttons: [], links: [], inputsOutsideForm: [],
    jsonLd: [], tables: [],
    semanticElements: { nav: 0, header: 0, main: 0, article: 0, section: 0, aside: 0, footer: 0 },
  };
}

function parseDom(html: string, baseUrl: string): DomFeatures {
  let document: Document;
  try { ({ document } = parseHTML(html) as { document: Document }); } catch { return emptyDomFeatures(); }

  const out = emptyDomFeatures();
  const baseHost = safeHostname(baseUrl);

  // Title + meta
  out.title = (document.querySelector('title')?.textContent ?? '').trim();
  const desc = document.querySelector('meta[name="description"]')?.getAttribute('content')
    ?? document.querySelector('meta[property="og:description"]')?.getAttribute('content');
  if (desc) out.description = desc;
  const ogType = document.querySelector('meta[property="og:type"]')?.getAttribute('content');
  if (ogType) out.ogType = ogType;

  // Semantic elements count
  for (const tag of ['nav', 'header', 'main', 'article', 'section', 'aside', 'footer']) {
    out.semanticElements[tag] = document.querySelectorAll(tag).length;
  }

  // Forms (max 20)
  for (const form of [...document.querySelectorAll('form')].slice(0, 20)) {
    const fields: FormField[] = [];
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
    out.forms.push({
      id: form.getAttribute('id') ?? undefined,
      action: resolveUrl(form.getAttribute('action'), baseUrl),
      method: (form.getAttribute('method') ?? 'GET').toUpperCase(),
      fields,
      ariaLabel: form.getAttribute('aria-label') ?? undefined,
    });
  }

  // Buttons (max 30)
  for (const btn of [...document.querySelectorAll('button, [role="button"]')].slice(0, 30)) {
    const text = (btn.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const ariaLabel = btn.getAttribute('aria-label') ?? undefined;
    if (!text && !ariaLabel) continue;
    out.buttons.push({ text, ariaLabel, dataAction: btn.getAttribute('data-action') ?? undefined });
  }

  // Inputs outside forms (React controlled components)
  for (const input of [...document.querySelectorAll('input, select, textarea')].slice(0, 20)) {
    if (input.closest('form')) continue;
    const name = input.getAttribute('name') ?? input.getAttribute('id') ?? '';
    if (!name) continue;
    const tag = input.tagName.toLowerCase();
    out.inputsOutsideForm.push({
      name,
      type: tag === 'input' ? input.getAttribute('type') ?? 'text' : tag,
      placeholder: input.getAttribute('placeholder') ?? undefined,
    });
  }

  // Links (max 50)
  for (const a of [...document.querySelectorAll('a[href]')].slice(0, 50)) {
    const raw = a.getAttribute('href') ?? '';
    if (!raw || /^(?:#|mailto:|javascript:|tel:)/.test(raw)) continue;
    const resolved = resolveUrl(raw, baseUrl) ?? raw;
    const linkHost = safeHostname(resolved);
    out.links.push({
      href: resolved,
      text: (a.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 100),
      isInternal: !!linkHost && !!baseHost && linkHost === baseHost,
    });
  }

  // Tables (max 10)
  for (const tbl of [...document.querySelectorAll('table')].slice(0, 10)) {
    const caption = tbl.querySelector('caption')?.textContent?.trim() || undefined;
    const columns = [...tbl.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim()).filter(Boolean);
    const rowCount = tbl.querySelectorAll('tbody tr').length || tbl.querySelectorAll('tr').length;
    out.tables.push({ caption, columns, rowCount });
  }

  // JSON-LD structured data
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 10)) {
    try {
      const parsed = JSON.parse(script.textContent ?? '');
      if (parsed && typeof parsed === 'object') out.jsonLd.push(parsed);
    } catch { /* skip malformed */ }
  }

  return out;
}

function resolveUrl(maybeRel: string | null | undefined, base: string): string | undefined {
  if (!maybeRel) return undefined;
  try { return new URL(maybeRel, base).toString(); } catch { return undefined; }
}
function safeHostname(url: string): string | undefined {
  try { return new URL(url).hostname || undefined; } catch { return undefined; }
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 hypermove-scanner/0.1' },
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
    try {
      urls.push(new URL(m[1]!, base).toString());
    } catch { /* ignore invalid URLs */ }
  }
  return urls.slice(0, MAX_BUNDLES);
}

function runDetector(rule: DetectorRule, corpus: string): DetectedPrimitive {
  const evidence: string[] = [];
  let signal = 0;
  let hasStrong = false;
  const lower = corpus.toLowerCase();

  // Check contract addresses
  if (rule.anyOf.addressesLower?.length) {
    for (const addr of rule.anyOf.addressesLower) {
      if (lower.includes(addr)) {
        signal += 1;
        hasStrong = true;
        evidence.push(`addr:${addr.slice(0, 10)}...`);
      }
    }
  }

  // Check regex patterns
  if (rule.anyOf.patterns?.length) {
    for (const p of rule.anyOf.patterns) {
      try {
        if (new RegExp(p, 'i').test(corpus)) {
          signal += 0.4;
          evidence.push(`pat:${p}`);
        }
      } catch { /* invalid regex */ }
    }
  }

  // Check npm imports
  if (rule.anyOf.imports?.length) {
    for (const imp of rule.anyOf.imports) {
      if (corpus.includes(`'${imp}'`) || corpus.includes(`"${imp}"`)) {
        signal += 0.5;
        hasStrong = true;
        evidence.push(`imp:${imp}`);
      }
    }
  }

  const weight = rule.weight ?? 1;
  const confidence = Math.min(1, signal * weight);
  return {
    name: rule.name,
    detected: hasStrong && confidence >= 0.5,
    confidence: Math.round(confidence * 100) / 100,
    evidence: evidence.slice(0, 5),
  };
}

function detectWalletAdapter(corpus: string): string {
  for (const a of WALLET_ADAPTERS) {
    if (a.patterns.some((p) => new RegExp(p, 'i').test(corpus))) return a.name;
  }
  return 'unknown';
}

function detectChains(corpus: string): number[] {
  const found = new Set<number>();
  for (const [cid, hints] of Object.entries(CHAIN_HINTS)) {
    for (const h of hints) {
      try {
        if (new RegExp(h, 'i').test(corpus)) { found.add(Number(cid)); break; }
      } catch { /* skip */ }
    }
  }
  return [...found].sort((a, b) => a - b);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scan a URL and detect web3 primitives + generic tools + crawl data (DOM).
 */
export async function scanUrl(url: string): Promise<ScanResult> {
  const start = Date.now();

  const html = await fetchText(url);
  if (!html) {
    return {
      url, scannedAt: new Date().toISOString(), durationMs: Date.now() - start,
      primitives: DETECTORS.map((d) => ({ name: d.name, detected: false, confidence: 0, evidence: [] })),
      walletAdapter: 'unknown', chains: [], genericTools: [], domFeatures: emptyDomFeatures(),
    };
  }

  const scriptUrls = extractScriptUrls(html, url);
  const bundles = await Promise.all(scriptUrls.map(fetchText));
  const corpus = [html, ...bundles].join('\n\n');

  const primitives = DETECTORS.map((d) => runDetector(d, corpus));
  const walletAdapter = detectWalletAdapter(corpus);
  const chains = detectChains(corpus);

  // DOM parsing — structured crawl data
  const domFeatures = parseDom(html, url);

  // Convert DOM features into generic tools
  const genericTools = domToTools(domFeatures);

  return {
    url, scannedAt: new Date().toISOString(), durationMs: Date.now() - start,
    primitives, walletAdapter, chains, genericTools, domFeatures,
  };
}

/** Convert parsed DOM features into generic tool definitions. */
function domToTools(dom: DomFeatures): GenericTool[] {
  const tools: GenericTool[] = [];
  for (const form of dom.forms) {
    const name = form.id || form.ariaLabel || (form.action ? `form_${form.action.replace(/\W+/g, '_').slice(0, 50)}` : null);
    if (!name || form.fields.length === 0) continue;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const f of form.fields) {
      properties[f.name] = { type: f.type === 'number' ? 'number' : 'string', ...(f.placeholder ? { description: f.placeholder } : {}) };
      if (f.required) required.push(f.name);
    }
    tools.push({ name, description: form.ariaLabel || `Form: ${form.method} ${form.action || '/'}`, inputSchema: { type: 'object', properties, required } });
  }
  for (const btn of dom.buttons) {
    if (!btn.dataAction) continue;
    tools.push({ name: btn.dataAction.slice(0, 64), description: btn.text || btn.ariaLabel || btn.dataAction, inputSchema: { type: 'object', properties: {} } });
  }
  return tools;
}

/**
 * Generate MCP manifest JSON from scan result.
 * This is the final output that agents can consume.
 */
export function generateMCPManifest(scan: ScanResult, opts?: { name?: string }): MCPManifest {
  const hostname = new URL(scan.url).hostname.replace(/^www\./, '');
  const name = opts?.name || `${hostname}-mcp`;

  // Include detected primitives + generic tools
  const tools = [
    ...scan.primitives
      .filter((p) => p.detected)
      .map((p) => {
        const rule = DETECTORS.find((d) => d.name === p.name)!;
        return {
          name: p.name,
          description: rule.description,
          inputSchema: buildSchemaForPrimitive(p.name),
          serverCompatible: rule.serverCompatible,
        };
      }),
    ...scan.genericTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      serverCompatible: false,
    })),
  ];

  return {
    name,
    version: '0.1.0',
    description: `Agent-callable tools extracted from ${scan.url}`,
    tools,
    chains: scan.chains,
    walletAdapter: scan.walletAdapter,
    generatedAt: new Date().toISOString(),
    sourceUrl: scan.url,
  };
}

/**
 * Emit a runnable MCP server (TypeScript source).
 * User/team deploys this on Lightsail → agents connect via MCP config.
 */
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

/**
 * Generate MCP config JSON that user pastes into Claude/Cursor/Kiro.
 * Takes the server host (IP or domain) and returns the config block.
 */
export function generateMCPConfig(manifest: MCPManifest, host: string): Record<string, unknown> {
  const url = host.startsWith('http') ? host : `http://${host}:3002`;
  return {
    mcpServers: {
      [manifest.name]: {
        url,
        transport: 'http',
        description: manifest.description,
        tools: manifest.tools.map((t) => t.name),
      },
    },
  };
}

/** Build a reasonable input schema for known primitives. */
function buildSchemaForPrimitive(name: string): Record<string, unknown> {
  const schemas: Record<string, Record<string, unknown>> = {
    'wallet.connect': { type: 'object', properties: { chainId: { type: 'number' } } },
    'tx.send': { type: 'object', properties: { to: { type: 'string' }, value: { type: 'string' }, data: { type: 'string' } }, required: ['to'] },
    'swap.execute': { type: 'object', properties: { tokenIn: { type: 'string' }, tokenOut: { type: 'string' }, amount: { type: 'string' } }, required: ['tokenIn', 'tokenOut', 'amount'] },
    'payment.send': { type: 'object', properties: { to: { type: 'string' }, amount: { type: 'string' }, token: { type: 'string' } }, required: ['to', 'amount'] },
    'payment.x402': { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    'lend.deposit': { type: 'object', properties: { asset: { type: 'string' }, amount: { type: 'string' } }, required: ['asset', 'amount'] },
    'nft.buy': { type: 'object', properties: { collection: { type: 'string' }, tokenId: { type: 'string' } }, required: ['collection', 'tokenId'] },
    'bridge.send': { type: 'object', properties: { token: { type: 'string' }, amount: { type: 'string' }, destinationChain: { type: 'number' } }, required: ['token', 'amount', 'destinationChain'] },
    'stake.deposit': { type: 'object', properties: { amount: { type: 'string' }, validator: { type: 'string' } }, required: ['amount'] },
    'dao.vote': { type: 'object', properties: { proposalId: { type: 'string' }, support: { type: 'boolean' } }, required: ['proposalId', 'support'] },
  };
  return schemas[name] || { type: 'object', properties: {} };
}
