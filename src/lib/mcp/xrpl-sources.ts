/**
 * src/lib/mcp/xrpl-sources.ts
 * ---------------------------
 * Curated XRPL-builder source allowlist + a small lexical corpus of the latest
 * XRPL resources (docs, XLS standards, XRPLF repos, Ripple insights). Powers
 * the FREE `xrpl-search` skill.
 *
 * SOLID / reuse-first:
 *  - Single Responsibility: this module owns ONLY the XRPL corpus + a thin
 *    ranking that delegates scoring to the shipped `lexicalSearch` — it does
 *    NOT reimplement the scorer.
 *  - Zero external cost: pure, in-memory, deterministic. No Exa, no network.
 *
 * The corpus maps 1:1 to `CatalogEntry` (id/service/kind/description/keywords)
 * so `lexicalSearch` ranks it for free; each entry's `service` is its
 * source_type, so the built-in per-service diversity quota naturally spreads
 * results across doc/spec/repo/blog sources.
 */

import { lexicalSearch } from './search';
import type { CatalogEntry } from './catalog';

export type XrplSourceType = 'docs' | 'xls' | 'github' | 'blog' | 'insights';

export interface XrplResource {
  title: string;
  url: string;
  snippet: string;
  source_type: XrplSourceType;
  /** ISO date (publish/update) when known, else null. */
  date: string | null;
}

/** The 7 curated XRPL-builder source domains (PRD-A allowlist). */
export const XRPL_ALLOWLIST: readonly string[] = [
  'xrpl.org/docs',
  'xls.xrpl.org',
  'github.com/XRPLF',
  'xrpl.org/blog',
  'ripple.com/insights',
  'dev.flare.network/fxrp',
  'docs.t54.ai',
  // v4.0 (N1/G3) — the two live XRPL ecosystem hubs this corpus previously
  // had zero awareness of. See xrpfi-sources.ts / xrpl-toolkit.ts / xrpl-hub-index.ts.
  'xrpl-ai.org',
  't54.ai',
  // Reference hub only (xrpl-toolkit.ts) — not a yield-data source. See the
  // aigent.run entry's description for why its unverified venues are excluded.
  'aigent.run',
] as const;

/**
 * Curated corpus of latest XRPL build resources. Kept small + high-signal:
 * canonical docs, active XLS standards, core XRPLF repos, and freshness sources.
 * Extend by appending — no consumer change (Open/Closed).
 */
export const XRPL_CORPUS: readonly XrplResource[] = [
  { title: 'Multi-Purpose Tokens (MPT) — issue, clawback, freeze', url: 'https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens', snippet: 'How to issue Multi-Purpose Tokens on XRPL including clawback, freeze and metadata flags.', source_type: 'docs', date: '2025-11-02' },
  { title: 'XLS-33 Multi-Purpose Tokens standard', url: 'https://xls.xrpl.org/XLS-0033-multi-purpose-tokens', snippet: 'The XLS-33d specification defining MPT objects, issuance transactions and clawback semantics.', source_type: 'xls', date: '2025-09-18' },
  { title: 'XLS-66 Lending Protocol (draft)', url: 'https://xls.xrpl.org/XLS-0066-lending-protocol', snippet: 'Native on-ledger lending: loan brokers, vaults, first-loss capital and default handling.', source_type: 'xls', date: '2026-05-30' },
  { title: 'Single-Asset Vault (XLS-65)', url: 'https://xls.xrpl.org/XLS-0065-single-asset-vault', snippet: 'Tokenized vault primitive backing the lending protocol and RWA yield strategies.', source_type: 'xls', date: '2026-04-11' },
  { title: 'Issuing a stablecoin / IOU on XRPL', url: 'https://xrpl.org/docs/tutorials/how-tos/use-tokens/issue-a-fungible-token', snippet: 'Trust lines, issuing addresses, rippling and freeze — the canonical stablecoin issuance flow.', source_type: 'docs', date: '2025-08-22' },
  { title: 'Automated Market Maker (AMM) concepts', url: 'https://xrpl.org/docs/concepts/tokens/decentralized-exchange/automated-market-makers', snippet: 'XRPL native AMM: pools, LP tokens, auction slots and how it interacts with the CLOB DEX.', source_type: 'docs', date: '2025-07-15' },
  { title: 'XRPL x402 agentic payments', url: 'https://xrpl.org/docs/agents/agentic-payments-x402', snippet: 'HTTP 402 paywalls settled on XRPL — the exact scheme, memos and facilitator handshake.', source_type: 'docs', date: '2026-03-04' },
  { title: 'T54 XRPL x402 facilitator docs', url: 'https://xrpl-x402.t54.ai/docs/xrpl-scheme', snippet: 'Reference facilitator: /verify + /settle, invoice-binding memos and the exact wire format.', source_type: 'docs', date: '2026-02-20' },
  { title: 'RLUSD on XRPL — developer guide', url: 'https://ripple.com/insights/rlusd-developer-guide', snippet: 'Ripple USD trust lines, issuer, currency code and how to accept RLUSD payments.', source_type: 'insights', date: '2026-01-28' },
  { title: 'xrpl.js — JavaScript/TypeScript client', url: 'https://github.com/XRPLF/xrpl.js', snippet: 'The official XRPL JS/TS SDK: submit transactions, subscribe to ledgers, sign locally.', source_type: 'github', date: '2026-06-01' },
  { title: 'rippled — core XRPL server', url: 'https://github.com/XRPLF/rippled', snippet: 'Reference C++ server implementing the XRP Ledger consensus protocol and transactor rules.', source_type: 'github', date: '2026-06-20' },
  { title: 'XRPL Standards (XLS) repository', url: 'https://github.com/XRPLF/XRPL-Standards', snippet: 'Where all XLS proposals live — track lending, MPT, permissioned domains and DID drafts.', source_type: 'github', date: '2026-06-18' },
  { title: 'Permissioned Domains (XLS-80)', url: 'https://xls.xrpl.org/XLS-0080-permissioned-domains', snippet: 'On-ledger compliance domains gating who can hold/transfer regulated tokens.', source_type: 'xls', date: '2026-03-22' },
  { title: 'Credentials (XLS-70) for on-chain KYC', url: 'https://xls.xrpl.org/XLS-0070-credentials', snippet: 'Issue and verify verifiable credentials on XRPL for permissioned DeFi and RWA.', source_type: 'xls', date: '2026-02-05' },
  { title: 'Flare FXRP — bridged XRP for DeFi', url: 'https://dev.flare.network/fxrp/overview', snippet: 'Mint FXRP against XRP via FAssets to use XRP liquidity in Flare smart contracts.', source_type: 'docs', date: '2026-04-30' },
  { title: 'Batch transactions (XLS-56)', url: 'https://xls.xrpl.org/XLS-0056-batch', snippet: 'Atomically submit multiple transactions — build multi-step agent flows on XRPL.', source_type: 'xls', date: '2026-01-12' },
  { title: 'XRPL DEX: offers and order books', url: 'https://xrpl.org/docs/concepts/tokens/decentralized-exchange', snippet: 'Native central-limit order book: OfferCreate, book_offers and path-based cross-currency payments.', source_type: 'docs', date: '2025-10-09' },
  { title: 'Hooks — lightweight smart contracts', url: 'https://xrpl.org/blog/2024/hooks-amendment-progress', snippet: 'Programmable transaction logic on XRPL side-chains and the mainnet amendment roadmap.', source_type: 'blog', date: '2025-12-14' },
];

export interface XrplSearchOptions {
  query: string;
  sourceTypes?: XrplSourceType[];
  limit?: number;
}

export interface XrplSearchResult {
  results: XrplResource[];
  total: number;
}

const SOURCE_TYPES: readonly XrplSourceType[] = ['docs', 'xls', 'github', 'blog', 'insights'];

/** Cheap tokenizer for deriving keywords (mirrors the scorer's tokenization). */
function keywordsOf(r: XrplResource): string[] {
  return Array.from(
    new Set(
      `${r.title} ${r.snippet} ${r.source_type}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1),
    ),
  );
}

/**
 * Rank the curated XRPL corpus for a builder query. Delegates scoring to the
 * shipped `lexicalSearch` (no scorer duplication); maps hits back to the rich
 * resource shape via a stable id map. Zero external cost.
 */
export function searchXrplResources(opts: XrplSearchOptions): XrplSearchResult {
  const wanted = new Set(opts.sourceTypes?.filter((t) => SOURCE_TYPES.includes(t)) ?? []);
  const pool = wanted.size ? XRPL_CORPUS.filter((r) => wanted.has(r.source_type)) : XRPL_CORPUS;

  const byId = new Map<string, XrplResource>();
  const entries: CatalogEntry[] = pool.map((r, i) => {
    const id = `xrpl.${r.source_type}.${i}`;
    byId.set(id, r);
    return {
      id,
      service: r.source_type, // spreads diversity across source types
      kind: 'dapp',
      description: `${r.title} — ${r.snippet}`,
      keywords: keywordsOf(r),
      priceTier: 't1_read',
    };
  });

  const ranked = lexicalSearch(entries, { query: opts.query, limit: opts.limit ?? 8 });
  const results = ranked.hits.map((h) => byId.get(h.id)).filter((r): r is XrplResource => Boolean(r));
  return { results, total: ranked.total };
}
