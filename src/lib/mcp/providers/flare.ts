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
/** N5 — corpus-grounded (not live-contract) FXRP bridge lifecycle + adoption data. */
const BRIDGE_STATUS_METHODS = new Set(['flareFassetsBridgeStatus']);
/**
 * Confidential MCP tool tier (Sub-PRD B) — FCC/PMW-aware methods. Gated on a
 * genuine external-state check (isFccLiveOnNetwork), never a static flag:
 * softEmpty until FCC is confirmed live on Songbird, same "wrong on-chain call
 * is worse than an honest not-live-yet" discipline as CORPUS_ONLY above.
 */
const FCC_METHODS = new Set(['flareConfidentialSwap', 'flareConfidentialStatus']);
/** Distinct from FCC_METHODS on purpose — see isHyperMoveTeeExtensionLive()'s doc comment. */
const HM_TEE_METHODS = new Set(['hypermoveTeeExtensionStatus']);
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
    return (
      FLARE_NETWORKS.has(chain.split('-')[0]) &&
      (FTSO_METHODS.has(method) || CORPUS_ONLY.has(method) || BRIDGE_STATUS_METHODS.has(method) || FCC_METHODS.has(method) || HM_TEE_METHODS.has(method) || GENERIC.has(method))
    );
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

  /**
   * FCC live-status check — queries the same FlareContractRegistry pattern as
   * resolveFtsoV2() (no duplicated ABI/registry constants) for a
   * "FlareConfidentialCompute" registry entry. Songbird-only (FCC ships to
   * Songbird canary first); fails closed on ANY error — a registry lookup
   * failing is treated as not-live, never assumed live.
   *
   * Deliberately does NOT accept 'coston2' — this check answers "has Flare
   * itself shipped real FCC (hardware TEE) to this network," not "is
   * HyperMove's own dev extension reachable." See isHyperMoveTeeExtensionLive()
   * below for the honestly-separate Coston2 dev-path check. Conflating the
   * two would report "FCC is live" when what's actually true is "our own
   * SIMULATED_TEE=true extension answered on a dev testnet" — exactly the
   * kind of fabrication this file's module doc already forbids.
   */
  private async isFccLiveOnNetwork(network: string, client: PublicClient): Promise<boolean> {
    if (network !== 'songbird') return false;
    try {
      const addr = (await client.readContract({
        address: FLARE_CONTRACT_REGISTRY as Address,
        abi: REGISTRY_ABI,
        functionName: 'getContractAddressByName',
        args: ['FlareConfidentialCompute'], // exact registry name TBD on real deployment
      })) as Address;
      return !!addr && !/^0x0+$/.test(addr);
    } catch {
      return false;
    }
  }

  /**
   * Dream Cycle Confidential Extraction on Flare FCC — Coston2 dev-extension
   * liveness check, deliberately separate from isFccLiveOnNetwork() above.
   * Coston2 never carries real FCC hardware; this only confirms HyperMove's
   * own services/tee-extension (Go ext-proxy + extension-tee,
   * SIMULATED_TEE=true) is configured and reachable. Never conflate this
   * result with "real Flare FCC is live" — callers must keep the two network
   * branches (songbird vs coston2) visibly distinct in whatever they report
   * (see flare-instruct.ts / dream/extract.ts for the caller-side network
   * selection and honest labeling).
   *
   * Fails closed on ANY error, same discipline as isFccLiveOnNetwork(): an
   * unset env var or an unreachable proxy is "not live," never assumed live.
   */
  async isHyperMoveTeeExtensionLive(network: string): Promise<boolean> {
    if (network !== 'coston2') return false;
    const proxyUrl = process.env.TEE_EXTENSION_PROXY_URL;
    const senderAddr = process.env.FLARE_INSTRUCTION_SENDER_ADDRESS;
    if (!proxyUrl || !senderAddr) return false;
    try {
      const res = await fetch(`${proxyUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Real FCC-backed execution path — implemented once FCC ships. This stub is
   * intentionally incomplete per Sub-PRD B's explicit scope boundary: the real
   * contract interface is not yet publicly available (dev.flare.network/fcc/overview),
   * so guessing an ABI here would risk a wrong on-chain call — worse than an
   * honest "not yet implemented" refusal. Unreachable until isFccLiveOnNetwork()
   * returns true, which cannot happen until Flare's registry has the contract.
   */
  private async executeFccConfidential(input: ProviderCall): Promise<ServiceResult<unknown>> {
    return fail(this.name, `${input.method} is not yet implemented — FCC interface not finalized`, {
      code: 'fcc_not_implemented',
      hint: 'FCC live-status was detected on-chain, but the real execution ABI is not yet published. Track dev.flare.network/fcc/overview for the interface spec.',
    });
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
      if (BRIDGE_STATUS_METHODS.has(input.method)) {
        return ok({
          asset: 'FXRP',
          description: '1:1 representation of XRP on Flare. Mint by sending XRP on XRPL; Flare Data Connector verifies the event; FXRP is minted on Songbird/Flare.',
          mintedToDate: '155M+ FXRP minted in first 7 months (flare.network/products/fassets, captured 2026-07-18)',
          lifecycle: [
            '1. Send XRP on XRPL',
            '2. Flare Data Connector verifies the external-chain event',
            '3. FXRP minted on Flare/Songbird',
            '4. Use FXRP in DeFi (trade / lend-borrow / vaults)',
            '5. Redeem back to native XRP on XRPL',
          ],
          useCases: ['Trade & provide liquidity', 'Lend & borrow (collateral)', 'Vaults & strategies', 'Exchange-native XRPFi via Flare Smart Accounts'],
          note: 'Live mint-capacity and per-agent-vault state require a verified on-chain read against the AssetManager contract — not yet wired (pending interface verification, see flareFassetsFxrp).',
          source: 'https://flare.network/products/fassets',
          network,
        });
      }
      if (FCC_METHODS.has(input.method)) {
        const live = await this.isFccLiveOnNetwork(network, client);
        if (!live) {
          return softEmpty(
            this.name,
            `${input.method} requires Flare Confidential Compute, not yet live on ${network}`,
            'FCC governance vote + Songbird canary deployment pending. Check flare.fassets.bridgeStatus-style tooling or dev.flare.network/fcc/overview for current status. PMW is XRPL-only at launch.',
          );
        }
        return this.executeFccConfidential(input);
      }
      if (HM_TEE_METHODS.has(input.method)) {
        // Deliberately separate result shape from FCC_METHODS above — this
        // reports HyperMove's own Coston2 dev-extension reachability, never
        // "real Flare FCC is live." See isHyperMoveTeeExtensionLive()'s doc
        // comment for why the two must never be conflated.
        const live = await this.isHyperMoveTeeExtensionLive(network);
        if (!live) {
          return softEmpty(
            this.name,
            `HyperMove's tee-extension is not configured/reachable on ${network}`,
            'This checks HyperMove\'s own SIMULATED_TEE=true dev extension on Coston2, NOT real Flare FCC (which remains Songbird-only). Set TEE_EXTENSION_PROXY_URL/FLARE_INSTRUCTION_SENDER_ADDRESS once services/tee-extension is deployed.',
          );
        }
        return ok({ network, live: true, kind: 'hypermove-dev-extension', simulated: true });
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
