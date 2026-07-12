/**
 * src/lib/mcp/payment-router.ts
 * -----------------------------
 * Lets an agent choose the network + rail + asset to pay on. Supported networks
 * are DERIVED from registry.ts (single source of truth) — adding a chain there
 * surfaces it here with no change (Open/Closed). Rails implement one interface;
 * MockPaymentRail is the mock-first default (n-payment adapters swap in later).
 */

import { createHash } from 'node:crypto';
import { ok, fail, type ServiceResult } from './envelope';
import { CHAINS, PROTOCOLS, chainById } from '../registry';
import { createNPaymentRail, isRealPaymentsConfigured } from './npayment-rails';

export type RailId = 'x402' | 'mpp';

export interface NetworkOption {
  chain: string;
  name: string;
  kind: string;
  rails: RailId[];
  assets: string[];
}

export interface PaymentSelection {
  chain: string;
  rail: RailId;
  asset: string;
}

export interface PaymentReceipt {
  txHash: string;
  chain: string;
  rail: RailId;
  asset: string;
  amount: string;
  /** Paying address, when the rail can resolve it (e.g. XRPL settlement). */
  payer?: string;
}

export interface PaymentRail {
  readonly id: RailId;
  /** True for the deterministic mock rail (blocked from granting paid sessions in prod). */
  readonly isMock: boolean;
  settle(input: { selection: PaymentSelection; amount: string; userId: string; proof?: string }): Promise<ServiceResult<PaymentReceipt>>;
}

/** Chains that carry a given protocol id. */
function chainsFor(protocolId: string): Set<string> {
  const p = PROTOCOLS.find((x) => x.id === protocolId);
  return new Set(p ? p.chains : []);
}

function assetsFor(chain: string): string[] {
  const assets = new Set<string>(['USDC']);
  if (chainsFor('rlusd').has(chain)) assets.add('RLUSD');
  if (chain.startsWith('xrpl')) assets.add('RLUSD');
  if (chain.startsWith('stellar')) assets.add('MGUSD');
  assets.add('USDT');
  return Array.from(assets).sort();
}

let cachedNetworks: NetworkOption[] | null = null;

/** The supported networks × rails × assets matrix, derived from registry.ts. */
export function supportedNetworks(): NetworkOption[] {
  if (cachedNetworks) return cachedNetworks;
  const x402Chains = chainsFor('x402');
  const xrplX402 = chainsFor('xrpl-x402');
  const mppChains = chainsFor('mpp');

  const out: NetworkOption[] = [];
  for (const c of CHAINS) {
    if (!c.supported) continue;
    const rails: RailId[] = [];
    if (x402Chains.has(c.id) || xrplX402.has(c.id) || c.kind === 'stellar') rails.push('x402');
    if (mppChains.has(c.id)) rails.push('mpp');
    if (rails.length === 0) continue; // no payment coverage → not selectable
    out.push({ chain: c.id, name: c.name, kind: c.kind, rails, assets: assetsFor(c.id) });
  }
  cachedNetworks = out.sort((a, b) => a.chain.localeCompare(b.chain));
  return cachedNetworks;
}

/** Validate an agent's selection against the supported matrix. */
export function validateSelection(sel: Partial<PaymentSelection>): ServiceResult<PaymentSelection> {
  const nets = supportedNetworks();
  const net = nets.find((n) => n.chain === sel.chain);
  if (!net) {
    return fail('payment', `unsupported network "${sel.chain}"`, {
      code: 'bad_network',
      hint: `valid networks: ${nets.map((n) => n.chain).join(', ')}`,
    });
  }
  const rail = (sel.rail ?? net.rails[0]) as RailId;
  if (!net.rails.includes(rail)) {
    return fail('payment', `network ${net.chain} does not support rail "${rail}"`, { code: 'bad_rail', hint: `valid rails: ${net.rails.join(', ')}` });
  }
  const asset = sel.asset ?? net.assets[0];
  if (!net.assets.includes(asset)) {
    return fail('payment', `network ${net.chain} does not support asset "${asset}"`, { code: 'bad_asset', hint: `valid assets: ${net.assets.join(', ')}` });
  }
  return ok({ chain: net.chain, rail, asset });
}

/** Deterministic mock rail — verifies any proof and returns a stable receipt. */
export class MockPaymentRail implements PaymentRail {
  readonly isMock = true;
  constructor(readonly id: RailId) {}
  async settle(input: { selection: PaymentSelection; amount: string; userId: string; proof?: string }): Promise<ServiceResult<PaymentReceipt>> {
    const seed = `${input.userId}:${input.selection.chain}:${input.amount}:${input.proof ?? 'mock'}`;
    const txHash = `0x${createHash('sha256').update(seed).digest('hex').slice(0, 64)}`;
    return ok({ txHash, chain: input.selection.chain, rail: this.id, asset: input.selection.asset, amount: input.amount });
  }
}

/**
 * Select the rail implementation for a chain/rail. Credential-driven: returns
 * the real n-payment rail when settlement credentials are configured, else the
 * mock (dev / zero-config). Same PaymentRail interface — no caller change.
 */
export function selectRail(sel: PaymentSelection): PaymentRail {
  if (isRealPaymentsConfigured()) return createNPaymentRail(sel.rail);
  return new MockPaymentRail(sel.rail);
}

/** Parse selection headers on an incoming request. */
export function parseSelection(headers: Headers): Partial<PaymentSelection> {
  const chain = headers.get('x-payment-chain') ?? undefined;
  const rail = (headers.get('x-payment-rail') as RailId | null) ?? undefined;
  const asset = headers.get('x-payment-asset') ?? undefined;
  return { chain, rail, asset };
}

export { chainById };

/** Test hook. */
export function _resetNetworks(): void {
  cachedNetworks = null;
}
