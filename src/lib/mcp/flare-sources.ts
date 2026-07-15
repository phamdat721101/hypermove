/**
 * src/lib/mcp/flare-sources.ts
 * ----------------------------
 * Curated Flare-builder corpus (FTSO / FAssets / FDC / FCC / FXRP). Mirrors
 * xrpl-sources.ts: a small, high-signal, source-labeled, in-memory corpus that
 * grounds the `flare.builder.brief` synthesis tier. Zero network, deterministic.
 *
 * Every entry is source-labeled (url + date) so a brief figure can trace back
 * to it — this is what lets nim-enforcer verify a brief before it ships.
 * Extend by appending (Open/Closed).
 */

export interface CorpusResource {
  title: string;
  url: string;
  snippet: string;
  source_type: 'docs' | 'reference' | 'blog';
  date: string | null;
}

export const FLARE_CORPUS: readonly CorpusResource[] = [
  { title: 'FTSOv2 block-latency feeds', url: 'https://dev.flare.network/ftso/feeds', snippet: '~1000 free decentralized price feeds (crypto/equities/commodities), 100 providers, ~90s updates, 2-week history, free to query on Flare.', source_type: 'docs', date: '2026-07-15' },
  { title: 'Read FTSO feeds offchain', url: 'https://dev.flare.network/ftso/guides/read-feeds-offchain', snippet: 'FtsoV2.getFeedById(bytes21) returns (value, decimals, timestamp); FtsoV2 resolved via the FlareContractRegistry (same address all networks).', source_type: 'docs', date: '2026-07-15' },
  { title: 'FTSO anchor feeds + feed-ID encoding', url: 'https://dev.flare.network/ftso/scaling/anchor-feeds', snippet: 'Anchor feeds update every 90s; feed-ID = category(01 crypto) + hex(name) + zero-pad to 21 bytes.', source_type: 'reference', date: '2026-07-15' },
  { title: 'FAssets overview (FXRP)', url: 'https://dev.flare.network/fassets/overview', snippet: 'FAssets mints FXRP against XRP; AssetManager holds mint capacity, collateral and agent state. FXRP is XRP\u2019s DeFi home on Flare.', source_type: 'docs', date: '2026-07-15' },
  { title: 'FXRP overview', url: 'https://dev.flare.network/fxrp/overview', snippet: 'Bridge XRP into Flare smart contracts as FXRP to access Flare DeFi (lending, DEX) while XRPL-native lending is still in amendment voting.', source_type: 'docs', date: '2026-07-15' },
  { title: 'FDC — Flare Data Connector', url: 'https://dev.flare.network/fdc/overview', snippet: 'Attestation layer providing verifiable cross-chain data availability; underpins FXRP and FCC.', source_type: 'docs', date: '2026-07-15' },
  { title: 'FCC — Flare Confidential Compute', url: 'https://dev.flare.network/fcc/overview', snippet: 'TEE-backed confidential compute (Songbird canary first). PMW (Protocol Managed Wallets) is XRPL-only at launch.', source_type: 'docs', date: '2026-07-15' },
  { title: 'Flare network configuration', url: 'https://dev.flare.network/network/overview', snippet: 'Flare Mainnet chainId 14 (RPC flare-api.flare.network), Coston2 114, Songbird 19. EVM-compatible, ~1.8s blocks.', source_type: 'reference', date: '2026-07-15' },
];

/** Flatten the corpus to a stable, cache-friendly text block (stable-prefix for nim-cache). */
export function flareCorpusText(): string {
  return FLARE_CORPUS.map((r) => `- ${r.title} (${r.url}${r.date ? `, ${r.date}` : ''}): ${r.snippet}`).join('\n');
}
