/**
 * src/lib/mcp/goat-sources.ts
 * ----------------------------
 * Curated GOAT-builder corpus (GOAT Stack, BitVM2, Agent Infrastructure, x402).
 * Mirrors flare-sources.ts: a small, high-signal, source-labeled, in-memory
 * corpus that grounds the `goat.builder.brief` synthesis tier. Zero network,
 * deterministic.
 *
 * Every entry is source-labeled (url + date) so a brief figure can trace back
 * to it — this is what lets nim-enforcer verify a brief before it ships.
 * Extend by appending (Open/Closed).
 */

export interface CorpusResource {
  title: string;
  url: string;
  snippet: string;
  source_type: 'docs' | 'reference' | 'blog' | 'news';
  date: string | null;
}

export const GOAT_CORPUS: readonly CorpusResource[] = [
  { title: 'The GOAT Stack', url: 'https://goat.network/news/the-goat-stack', snippet: 'Value settles on Bitcoin — 6 layers: Bitcoin L1 → BitVM2 (trust-minimized zkRollup) → zkMIPS/Ziren proving → PoS sequencer + goat-geth EVM → native BTC yield → x402 + AgentKit.', source_type: 'docs', date: '2026-07-15' },
  { title: 'GOAT Agent Infrastructure', url: 'https://docs.goat.network/docs/agents/overview', snippet: 'Durable identity, machine-speed payments, and a practical runtime surface on Bitcoin-secured settlement. ERC-8004 identity + reputation.', source_type: 'docs', date: '2026-07-15' },
  { title: 'HyperMove on GOAT', url: 'https://goat.network/news/meet-hypermove', snippet: 'HyperMove is the 2nd GOAT AI Builder Grant project — n-payment SDK lets agents pay for APIs using Bitcoin as collateral in a single call, no private key.', source_type: 'news', date: '2026-07-13' },
  { title: 'x402 payment protocol', url: 'https://docs.goat.network/docs/x402/overview', snippet: '165M payments / $50M / 69K agents (spring 2026). HTTP 402 + WWW-Authenticate handshake for agent-native payments.', source_type: 'docs', date: '2026-07-15' },
  { title: 'Native BTC yield', url: 'https://goat.network/yield', snippet: 'Real BTC-denominated yield from real network activity (not inflation). Park treasury BTC and earn.', source_type: 'reference', date: '2026-07-15' },
  { title: 'GOAT networks + RPC', url: 'https://docs.goat.network/docs/build/networks-rpc', snippet: 'GOAT Mainnet chainId 2345 (rpc.goat.network), Testnet3 chainId 48816. Native currency BTC. EVM-compatible.', source_type: 'reference', date: '2026-07-15' },
];

/** Flatten the corpus to a stable, cache-friendly text block (stable-prefix for nim-cache). */
export function goatCorpusText(): string {
  return GOAT_CORPUS.map((r) => `- ${r.title} (${r.url}${r.date ? `, ${r.date}` : ''}): ${r.snippet}`).join('\n');
}
