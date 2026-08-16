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
import { isMcpGoatRailEnabled, isMcpAssetChoiceEnabled } from '../platform-flag';

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

export interface PaymentTerms {
  merchant: string;
  issuer: string;
  nonce: string;
}

export interface PaymentRail {
  readonly id: RailId;
  /** True for the deterministic mock rail (blocked from granting paid sessions in prod). */
  readonly isMock: boolean;
  /**
   * `tier` added 2026-08-10 (xrpl-rlusd-settlement-gap-feedback PRD 03) —
   * needed by the XRPL "already-submitted tx hash" settlement path
   * (npayment-rails.ts's settleXrplAlreadySubmitted()) to scope the replay-
   * protection record in mcp_xrpl_settled_txs. Every existing implementer
   * (createNPaymentRail, MockPaymentRail) already has `tier` available at
   * its one call site (paywall.ts's settleSelection()) — this is a pure
   * additive parameter, not a behavior change for any caller that doesn't
   * read it.
   */
  settle(input: { selection: PaymentSelection; amount: string; userId: string; tier: string; proof?: string; paymentTerms?: PaymentTerms }): Promise<ServiceResult<PaymentReceipt>>;
}

/** Chains that carry a given protocol id. */
function chainsFor(protocolId: string): Set<string> {
  const p = PROTOCOLS.find((x) => x.id === protocolId);
  return new Set(p ? p.chains : []);
}

function assetsFor(chain: string): string[] {
  const assets = new Set<string>(['USDC']);
  if (chainsFor('rlusd').has(chain)) assets.add('RLUSD');
  if (chain.startsWith('xrpl')) {
    assets.add('RLUSD');
    // Rule #33: native XRP for high-frequency micropayments (no trustline)
    if (isMcpAssetChoiceEnabled()) assets.add('XRP');
  }
  if (chain.startsWith('stellar')) assets.add('MGUSD');
  // GOAT native currency is BTC (WGBTC), not USDC
  if (chain.startsWith('goat') && isMcpGoatRailEnabled()) assets.add('BTC');
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

/**
 * The confidential price tier settles exclusively via XRPL — Flare's own PMW
 * is XRPL-only at launch, so payment for confidentially-executed Flare
 * operations stays coherent with that (see Sub-PRD C's design rationale).
 * Used only by the confidential settlement path; supportedNetworks() itself
 * stays unrestricted for every other tier.
 */
const CONFIDENTIAL_TIER_CHAINS = new Set(['xrpl-mainnet', 'xrpl-testnet']);

export function validateConfidentialSelection(sel: Partial<PaymentSelection>): ServiceResult<PaymentSelection> {
  if (!sel.chain || !CONFIDENTIAL_TIER_CHAINS.has(sel.chain)) {
    return fail('payment', `confidential tier settles exclusively via XRPL`, {
      code: 'bad_network',
      hint: `valid networks for the confidential tier: ${Array.from(CONFIDENTIAL_TIER_CHAINS).join(', ')}`,
    });
  }
  return validateSelection(sel); // delegate to the existing general validator for asset/rail checks
}

/** Dream consolidation has one deliberately narrow v2 settlement contract:
 * validated XRPL payment over x402 in RLUSD. Keeping this separate from the
 * legacy confidential tier avoids widening either product accidentally. */
export function validateDreamSelection(sel: Partial<PaymentSelection>): ServiceResult<PaymentSelection> {
  if (!sel.chain || !CONFIDENTIAL_TIER_CHAINS.has(sel.chain)) {
    return fail('payment', 'dream tier settles exclusively via XRPL RLUSD', {
      code: 'bad_network', hint: `valid networks: ${Array.from(CONFIDENTIAL_TIER_CHAINS).join(', ')}`,
    });
  }
  if (sel.asset !== undefined && sel.asset !== 'RLUSD') {
    return fail('payment', 'dream tier requires RLUSD', { code: 'bad_asset', hint: 'asset must be RLUSD' });
  }
  return validateSelection({ ...sel, rail: sel.rail ?? 'x402', asset: 'RLUSD' });
}

/** Deterministic mock rail — verifies any proof and returns a stable receipt. */
export class MockPaymentRail implements PaymentRail {
  readonly isMock = true;
  constructor(readonly id: RailId) {}
  async settle(input: { selection: PaymentSelection; amount: string; userId: string; tier: string; proof?: string; paymentTerms?: PaymentTerms }): Promise<ServiceResult<PaymentReceipt>> {
    const seed = `${input.userId}:${input.selection.chain}:${input.amount}:${input.proof ?? 'mock'}`;
    const txHash = `0x${createHash('sha256').update(seed).digest('hex').slice(0, 64)}`;
    return ok({ txHash, chain: input.selection.chain, rail: this.id, asset: input.selection.asset, amount: input.amount, payer: `mock:${input.userId}` });
  }
}

/**
 * Select the rail implementation for a chain/rail. Credential-driven: returns
 * the real n-payment rail when settlement credentials are configured, else the
 * mock (dev / zero-config). Same PaymentRail interface — no caller change.
 */
export function selectRail(sel: PaymentSelection): PaymentRail {
  if (isRealPaymentsConfigured(sel.chain)) return createNPaymentRail(sel.rail);
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
