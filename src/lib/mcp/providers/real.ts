/**
 * src/lib/mcp/providers/real.ts
 * -----------------------------
 * The three real web3 data adapters (Moralis / Alchemy / QuickNode). They all
 * share ONE HttpProvider base — the fetch + envelope-normalize + secret-redact +
 * mock-fallback logic is written once, not copied three times.
 *
 * mock-first: when the adapter's API key is absent, call() transparently
 * delegates to the injected MockProvider, so dev stays zero-config and the
 * whole gateway works before any key exists.
 *
 * Secrets (API keys) are read host-side from env and NEVER placed in the
 * returned envelope. redact() scrubs any accidental leakage.
 */

import { fail, ok, softEmpty, type ServiceResult } from '../envelope';
import { fetchWithTimeout } from '../http';
import { MockProvider } from './mock';
import type { DataProvider, ProviderCall, ProviderName } from './types';

/** Builds the upstream request for a canonical call, or null if unsupported. */
export type RequestBuilder = (
  input: ProviderCall,
  ctx: { apiKey: string; base: string },
) => { url: string; init?: RequestInit } | null;

export interface HttpProviderConfig {
  name: ProviderName;
  /** Env var holding the API key. Absent (with keyless=true) → public endpoint. */
  apiKeyEnv?: string;
  /** Public/keyless provider (Stellar Horizon, XRPL public RPC) — no key needed. */
  keyless?: boolean;
  /** Env var (or literal) for the base URL. */
  baseEnv: string;
  baseDefault: string;
  build: RequestBuilder;
  /** Normalize the raw JSON body into the payload shape we return. */
  normalize: (raw: unknown, input: ProviderCall) => unknown;
}

function redact(value: unknown, secret: string): unknown {
  if (!secret) return value;
  const json = JSON.stringify(value);
  if (!json.includes(secret)) return value;
  return JSON.parse(json.split(secret).join('***'));
}

export class HttpProvider implements DataProvider {
  readonly name: ProviderName;
  private readonly mock = new MockProvider();

  constructor(private readonly cfg: HttpProviderConfig) {
    this.name = cfg.name;
  }

  supports(method: string, chain: string): boolean {
    // Delegate support to the request builder — if it can build a URL, it's supported.
    const apiKey = (this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : '') ?? 'probe';
    const base = process.env[this.cfg.baseEnv] ?? this.cfg.baseDefault;
    return this.cfg.build({ method, chain, params: {} }, { apiKey, base }) !== null || this.mock.supports(method, chain);
  }

  async call(input: ProviderCall): Promise<ServiceResult<unknown>> {
    // Keyless providers (public endpoints) always call live; keyed providers
    // delegate to mock when their key is absent (zero-config dev).
    const apiKey = this.cfg.keyless ? '' : this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined;
    if (apiKey === undefined) return this.mock.call(input);

    const base = process.env[this.cfg.baseEnv] ?? this.cfg.baseDefault;
    const req = this.cfg.build(input, { apiKey, base });
    if (!req) return this.mock.call(input);

    try {
      const res = await fetchWithTimeout(req.url, req.init);
      if (res.status === 404) {
        return softEmpty(this.name, `no data for ${input.method} on ${input.chain}`);
      }
      if (!res.ok) {
        return fail(this.name, `upstream ${res.status}`, { status: res.status, code: 'upstream_error' });
      }
      const raw = await res.json().catch(() => null);
      const normalized = this.cfg.normalize(raw, input);
      if (normalized == null) return softEmpty(this.name, `empty response for ${input.method}`);
      return ok(redact(normalized, apiKey));
    } catch (err) {
      return fail(this.name, err instanceof Error ? err.message : String(err), { code: 'network_error' });
    }
  }
}

// ─── Concrete configs (doc-04 method tables) ───────────────────────────────

const EVM_CHAIN_IDS: Record<string, string> = {
  ethereum: '0x1', base: '0x2105', arbitrum: '0xa4b1', optimism: '0xa',
  polygon: '0x89', bnb: '0x38', avalanche: '0xa86a',
};
function chainHex(chain: string): string {
  return EVM_CHAIN_IDS[chain.split('-')[0]] ?? '0x1';
}

export function createMoralis(): HttpProvider {
  return new HttpProvider({
    name: 'moralis',
    apiKeyEnv: 'MORALIS_API_KEY',
    baseEnv: 'MORALIS_BASE_URL',
    baseDefault: 'https://deep-index.moralis.io/api/v2.2',
    build: (input, { apiKey, base }) => {
      const addr = String(input.params.address ?? input.params.tokenAddress ?? '');
      const chain = chainHex(input.chain);
      const headers = { 'X-API-Key': apiKey, accept: 'application/json' };
      switch (input.method) {
        case 'getTokenBalances': return { url: `${base}/wallets/${addr}/tokens?chain=${chain}`, init: { headers } };
        case 'getWalletTxns': return { url: `${base}/wallets/${addr}/history?chain=${chain}`, init: { headers } };
        case 'getTokenPrice': return { url: `${base}/erc20/${addr}/price?chain=${chain}`, init: { headers } };
        case 'getNftHoldings': return { url: `${base}/wallets/${addr}/nfts?chain=${chain}`, init: { headers } };
        case 'getTokenTransfers': return { url: `${base}/erc20/${addr}/transfers?chain=${chain}`, init: { headers } };
        case 'getTopTokenHolders': return { url: `${base}/erc20/${addr}/holders?chain=${chain}`, init: { headers } };
        default: return null;
      }
    },
    normalize: (raw) => raw ?? null,
  });
}

export function createAlchemy(): HttpProvider {
  return new HttpProvider({
    name: 'alchemy',
    apiKeyEnv: 'ALCHEMY_API_KEY',
    baseEnv: 'ALCHEMY_BASE_URL',
    baseDefault: 'https://{chain}-mainnet.g.alchemy.com/v2',
    build: (input, { apiKey, base }) => {
      const chain = input.chain.split('-')[0];
      const url = `${base.replace('{chain}', chain)}/${apiKey}`;
      const rpc = (method: string, params: unknown[]) => ({
        url,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) },
      });
      switch (input.method) {
        case 'getGasPrice': return rpc('eth_gasPrice', []);
        case 'getBlock': return rpc('eth_getBlockByNumber', [String(input.params.blockNumber ?? 'latest'), false]);
        case 'getTransactionReceipt': return rpc('eth_getTransactionReceipt', [String(input.params.txHash ?? '')]);
        case 'getContractState': return rpc('eth_call', [{ to: input.params.contract, data: input.params.data }, 'latest']);
        default: return null;
      }
    },
    normalize: (raw) => (raw as { result?: unknown } | null)?.result ?? null,
  });
}

export function createQuickNode(): HttpProvider {
  return new HttpProvider({
    name: 'quicknode',
    apiKeyEnv: 'QUICKNODE_ENDPOINT_URL', // full endpoint URL doubles as the key
    baseEnv: 'QUICKNODE_ENDPOINT_URL',
    baseDefault: '',
    build: (input, { base }) => {
      if (!base) return null;
      const rpc = (method: string, params: unknown[]) => ({
        url: base,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) },
      });
      switch (input.method) {
        case 'getTx': return rpc('eth_getTransactionByHash', [String(input.params.txHash ?? '')]);
        case 'getBlock': return rpc('eth_getBlockByNumber', [String(input.params.blockNumber ?? 'latest'), false]);
        default: return null;
      }
    },
    normalize: (raw) => (raw as { result?: unknown } | null)?.result ?? null,
  });
}

// ─── Stellar (Horizon REST + Soroban RPC) — keyless public endpoints ───────

export function createStellar(): HttpProvider {
  return new HttpProvider({
    name: 'stellar',
    keyless: true,
    baseEnv: 'STELLAR_HORIZON_URL',
    baseDefault: 'https://horizon.stellar.org',
    build: (input, { base }) => {
      const p = input.params;
      const id = String(p.account ?? p.address ?? '');
      const limit = Number(p.limit ?? 10);
      const soroban = process.env.SOROBAN_RPC_URL ?? 'https://mainnet.sorobanrpc.com';
      const rpc = (method: string, params: unknown) => ({
        url: soroban,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) },
      });
      switch (input.method) {
        case 'getAccount': return { url: `${base}/accounts/${id}` };
        case 'getPayments': return { url: `${base}/accounts/${id}/payments?order=desc&limit=${limit}` };
        case 'getAccountTxns': return { url: `${base}/accounts/${id}/transactions?order=desc&limit=${limit}` };
        case 'getOrderBook': return { url: `${base}/order_book?selling_asset_type=native&buying_asset_type=${p.buyingAssetType ?? 'native'}` };
        case 'getAssets': return { url: `${base}/assets?limit=${limit}${p.assetCode ? `&asset_code=${p.assetCode}` : ''}` };
        case 'getLatestLedger': return rpc('getLatestLedger', {});
        case 'getEvents': return rpc('getEvents', p);
        default: return null;
      }
    },
    // Horizon returns the payload directly; Soroban wraps it in `.result`.
    normalize: (raw) => (raw as { result?: unknown } | null)?.result ?? raw ?? null,
  });
}

// ─── XRPL (public JSON-RPC) — keyless public endpoints ─────────────────────

export function createXrpl(): HttpProvider {
  return new HttpProvider({
    name: 'xrpl',
    keyless: true,
    baseEnv: 'XRPL_RPC_URL',
    baseDefault: 'https://xrplcluster.com/',
    build: (input, { base }) => {
      const p = input.params;
      const account = String(p.account ?? p.address ?? '');
      const rpc = (method: string, params: Record<string, unknown>) => ({
        url: base,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) },
      });
      switch (input.method) {
        case 'xrplAccountInfo': return rpc('account_info', { account, ledger_index: 'validated' });
        case 'xrplAccountTx': return rpc('account_tx', { account, limit: Number(p.limit ?? 10) });
        case 'xrplAccountOffers': return rpc('account_offers', { account });
        case 'xrplBookOffers': return rpc('book_offers', { taker_gets: p.takerGets ?? { currency: 'XRP' }, taker_pays: p.takerPays });
        case 'xrplAmmInfo': return rpc('amm_info', p.amm ? { amm: p.amm } : { asset: p.asset, asset2: p.asset2 });
        case 'xrplTx': return rpc('tx', { transaction: String(p.txHash ?? p.transaction ?? '') });
        case 'xrplLedger': return rpc('ledger', { ledger_index: p.ledgerIndex ?? 'validated' });
        // M1 — XRPL deepening (MPT, vault, lending+amendment, amendments)
        case 'xrplMptIssuance': return rpc('ledger_entry', { mpt_issuance: String(p.mptIssuanceID ?? p.issuanceID ?? '') });
        case 'xrplVaultInfo': return rpc('ledger_entry', { vault_id: String(p.vaultID ?? '') });
        case 'xrplLendingStatus': return rpc('ledger_entry', { lending_pool: String(p.lendingPoolID ?? p.poolID ?? '') });
        case 'xrplAmendments': return rpc('ledger', { ledger_index: 'validated', transactions: false, expand: false, owner_funds: false });
        default: return null;
      }
    },
    normalize: (raw) => (raw as { result?: unknown } | null)?.result ?? raw ?? null,
  });
}
