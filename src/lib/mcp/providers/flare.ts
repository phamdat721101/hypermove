/**
 * src/lib/mcp/providers/flare.ts
 * ------------------------------
 * The Flare data adapter (M2, FEATURE_MCP_FLARE_V1) — keyless, free-to-query.
 *
 * Flare is NOT routed through Moralis/Alchemy (they don't serve Flare); it is a
 * dedicated public-RPC adapter (like Stellar / XRPL), reusing the shared
 * ServiceResult envelope + viem (already a core dep) for correct ABI encoding.
 *
 * Live surface:
 *  - generic EVM reads (getBlock / getGasPrice) over the public Flare RPC
 *  - FTSO block-latency feeds — the killer free 1000-feed oracle. Drift-proof:
 *    the FtsoV2 address is resolved at runtime via the FlareContractRegistry
 *    (same address on every Flare network), never hard-coded.
 *
 * Honest surface (no fabrication): FAssets / FDC / FCC reads return a
 * source-labeled `softEmpty` until their contract interfaces are verified —
 * the builder.brief tier grounds these in the curated corpus instead. This is
 * deliberate: a wrong on-chain call is worse than an honest "not-live-yet".
 *
 * SOLID: one responsibility (Flare reads); depends only on DataProvider +
 * envelope; adding a method is a new `case`, callers untouched (Open/Closed).
 */

import { createPublicClient, http, parseAbi, type Address, type PublicClient } from 'viem';
import { ok, fail, softEmpty, type ServiceResult } from '../envelope';
import { FLARE_RPC, FLARE_CONTRACT_REGISTRY, FTSOV2_FALLBACK, deriveFeedId } from './chain-constants';
import type { DataProvider, ProviderCall } from './types';

const REGISTRY_ABI = parseAbi([
  'function getContractAddressByName(string _name) view returns (address)',
]);
const FTSOV2_ABI = parseAbi([
  'function getFeedById(bytes21 _feedId) view returns (uint256 value, int8 decimals, uint64 timestamp)',
]);

const FTSO_METHODS = new Set(['flareFtsoFeed', 'flareFtsoAnchor']);
/** Registered + discoverable, but honestly not-live (grounded in corpus, not fabricated). */
const CORPUS_ONLY = new Set(['flareFassetsFxrp', 'flareFassetsAgents', 'flareFdcAttestation', 'flareFccStatus']);
const GENERIC = new Set(['getBlock', 'getGasPrice']);
const FLARE_NETWORKS = new Set(['flare', 'coston2', 'songbird']);

/** JSON-safe: viem returns bigint fields that don't serialize. */
function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export class FlareProvider implements DataProvider {
  readonly name = 'flare' as const;
  private readonly clients = new Map<string, PublicClient>();
  private readonly ftsoV2 = new Map<string, Address>();

  supports(method: string, chain: string): boolean {
    return FLARE_NETWORKS.has(chain.split('-')[0]) && (FTSO_METHODS.has(method) || CORPUS_ONLY.has(method) || GENERIC.has(method));
  }

  private client(network: string): PublicClient {
    let c = this.clients.get(network);
    if (!c) {
      const rpc = FLARE_RPC[network] ?? FLARE_RPC.flare;
      c = createPublicClient({ transport: http(rpc) });
      this.clients.set(network, c);
    }
    return c;
  }

  /** Drift-proof FtsoV2 resolution via the registry, cached per network. */
  private async resolveFtsoV2(network: string, client: PublicClient): Promise<Address | null> {
    const cached = this.ftsoV2.get(network);
    if (cached) return cached;
    try {
      const addr = (await client.readContract({
        address: FLARE_CONTRACT_REGISTRY as Address,
        abi: REGISTRY_ABI,
        functionName: 'getContractAddressByName',
        args: ['FtsoV2'],
      })) as Address;
      if (addr && !/^0x0+$/.test(addr)) {
        this.ftsoV2.set(network, addr);
        return addr;
      }
    } catch {
      /* fall through to pinned fallback */
    }
    const fallback = FTSOV2_FALLBACK[network] as Address | undefined;
    return fallback ?? null;
  }

  async call(input: ProviderCall): Promise<ServiceResult<unknown>> {
    const network = input.chain.split('-')[0];
    const client = this.client(network);

    try {
      if (input.method === 'getGasPrice') {
        return ok({ wei: (await client.getGasPrice()).toString(), network, source: 'eth_gasPrice' });
      }
      if (input.method === 'getBlock') {
        const bn = input.params.blockNumber;
        const block = await client.getBlock(bn != null && bn !== 'latest' ? { blockNumber: BigInt(bn as number) } : {});
        return ok({ ...(jsonSafe(block) as object), network, source: 'eth_getBlockByNumber' });
      }
      if (FTSO_METHODS.has(input.method)) {
        return this.readFtso(input, network, client);
      }
      if (CORPUS_ONLY.has(input.method)) {
        return softEmpty(
          this.name,
          `${input.method} is not yet wired to a verified on-chain read`,
          'grounded in the flare-sources corpus via *.builder.brief; live read pending interface verification',
        );
      }
      return softEmpty(this.name, `unsupported flare method ${input.method}`);
    } catch (err) {
      return fail(this.name, err instanceof Error ? err.message : String(err), { code: 'network_error' });
    }
  }

  /** FTSO block-latency feed read (FtsoV2.getFeedById) — the free 1000-feed oracle. */
  private async readFtso(input: ProviderCall, network: string, client: PublicClient): Promise<ServiceResult<unknown>> {
    const nameOrId = String(input.params.feedId ?? input.params.feed ?? input.params.name ?? 'BTC/USD');
    const category = input.method === 'flareFtsoAnchor' ? String(input.params.category ?? '01') : '01';
    const feedId = nameOrId.startsWith('0x') ? nameOrId : deriveFeedId(nameOrId, category);

    const ftsoV2 = await this.resolveFtsoV2(network, client);
    if (!ftsoV2) return softEmpty(this.name, `FtsoV2 unavailable on ${network}`, 'registry lookup + pinned fallback both empty');

    const [value, decimals, timestamp] = (await client.readContract({
      address: ftsoV2,
      abi: FTSOV2_ABI,
      functionName: 'getFeedById',
      args: [feedId as `0x${string}`],
    })) as readonly [bigint, number, bigint];

    const price = Number(value) / 10 ** Number(decimals);
    return ok({
      feed: nameOrId,
      feedId,
      value: value.toString(),
      decimals: Number(decimals),
      price,
      timestamp: Number(timestamp),
      network,
      kind: input.method === 'flareFtsoAnchor' ? 'anchor' : 'block-latency',
      source: 'FtsoV2.getFeedById (dev.flare.network/ftso)',
    });
  }
}

export function createFlare(): FlareProvider {
  return new FlareProvider();
}
