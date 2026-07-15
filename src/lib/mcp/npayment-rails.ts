/**
 * src/lib/mcp/npayment-rails.ts
 * -----------------------------
 * The REAL settlement rail — the n-payment SDK integration behind the
 * PaymentRail interface. Isolated in its own file so the optional heavy SDK is
 * lazy-imported and the rest of the gateway never hard-depends on it.
 *
 * Settlement path: canonical x402 / EIP-3009 `transferWithAuthorization`. The
 * agent signs an authorization to PAY_TO_ADDRESS (n-payment client-side); this
 * merchant rail decodes it via n-payment and broadcasts it from a facilitator
 * wallet, so the agent pays gaslessly and the merchant receives USDC.
 *
 * SOLID:
 *  - Single Responsibility: settlement only. Selection/validation stay in
 *    payment-router; session bookkeeping stays in paywall.
 *  - Liskov: returns the same ServiceResult<PaymentReceipt> envelope as the
 *    mock. On ANY missing config / verify failure it returns `fail` — it never
 *    fabricates a receipt (that safety is why the mock/real split is honest).
 *
 * Non-EVM rails (Stellar MPP, XRPL RLUSD) intentionally fail with a clear hint
 * until their adapter creds are wired — see docs/prd/mcp-gateway-v2.md.
 */

import { ok, fail, type ServiceResult } from './envelope';
import type { PaymentRail, PaymentReceipt, PaymentSelection, RailId } from './payment-router';

/** Canonical native-USDC token per EVM chain (Circle FiatTokenV2). */
const USDC: Record<string, `0x${string}`> = {
  'base-mainnet': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'arbitrum-mainnet': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  'optimism-mainnet': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  'polygon-mainnet': '0x3c499c542cEF5E3811e1192ce70d8cc03d5c3359',
  // GOAT mainnet (dogfood: HyperMove settles its own MCP on the funder's chain)
  // NOTE: as of 2026-07-15, GOAT mainnet has no native USDC (native currency is BTC).
  // The GOAT rail is advertised but will return an honest hint until USDC is deployed.
  // Settlement in native BTC/WGBTC is a future path behind a separate flag.
  'goat-mainnet': '0x0000000000000000000000000000000000000000', // sentinel: USDC-not-deployed
};

/** Settlement credentials present → use the real rail; otherwise mock. */
export function isRealPaymentsConfigured(): boolean {
  return !!(process.env.MCP_FACILITATOR_PRIVATE_KEY && process.env.PAY_TO_ADDRESS);
}

/** Resolve the viem chain object for a supported EVM x402 network, or null. */
async function resolveEvmChain(chain: string): Promise<import('viem').Chain | null> {
  const chains = (await import('viem/chains')) as unknown as Record<string, import('viem').Chain>;
  const map: Record<string, string> = {
    'base-mainnet': 'base', 'base-sepolia': 'baseSepolia',
    'arbitrum-mainnet': 'arbitrum', 'optimism-mainnet': 'optimism', 'polygon-mainnet': 'polygon',
    'goat-mainnet': 'goat', 'goat-testnet': 'goatTestnet', // GOAT chain objects (custom or from viem if available)
  };
  const key = map[chain];
  // viem doesn't ship GOAT chains; fall back to a minimal chain definition for RPC access.
  if ((chain === 'goat-mainnet' || chain === 'goat-testnet') && !chains[key]) {
    const { GOAT_CHAIN_IDS, GOAT_RPC } = await import('./providers/chain-constants');
    const id = chain === 'goat-mainnet' ? GOAT_CHAIN_IDS.goat : GOAT_CHAIN_IDS['goat-testnet'];
    return { id, name: chain, nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 }, rpcUrls: { default: { http: [GOAT_RPC[chain.split('-')[0]]] } } } as unknown as import('viem').Chain;
  }
  return key ? chains[key] ?? null : null;
}

function decodeProof(proof: string): { authorization: unknown; signature: `0x${string}` } {
  const json = proof.trim().startsWith('{') ? proof : Buffer.from(proof, 'base64').toString('utf8');
  const parsed = JSON.parse(json) as { authorization?: unknown; signature?: string } & Record<string, unknown>;
  const signature = String(parsed.signature ?? '') as `0x${string}`;
  return { authorization: parsed.authorization ?? parsed, signature };
}

/** Real rail: broadcast the buyer's EIP-3009 authorization from the facilitator wallet. */
export function createNPaymentRail(id: RailId): PaymentRail {
  return {
    id,
    isMock: false,
    async settle({ selection, amount, proof }): Promise<ServiceResult<PaymentReceipt>> {
      // XRPL/RLUSD settles through the T54 x402 facilitator, not EIP-3009.
      if (selection.chain.startsWith('xrpl')) {
        return settleXrplRlusd(id, selection, amount, proof);
      }

      const pk = process.env.MCP_FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined;
      if (!pk) return fail('npayment', 'facilitator key missing', { code: 'not_configured', hint: 'set MCP_FACILITATOR_PRIVATE_KEY' });
      if (!proof) return fail('npayment', 'missing x402 payment proof', { code: 'no_proof', hint: 'submit the base64 EIP-3009 authorization as `proof`' });

      const usdc = USDC[selection.chain];
      const viemChain = await resolveEvmChain(selection.chain);
      // GOAT USDC sentinel (zero address) → honest hint, not a fake receipt
      if (usdc === '0x0000000000000000000000000000000000000000') {
        return fail('npayment', 'USDC not deployed on GOAT mainnet', {
          code: 'unsupported_chain',
          hint: 'GOAT native currency is BTC. Native BTC settlement is planned; USDC-on-GOAT is not yet deployed. Use base/arbitrum/optimism/polygon for USDC.',
        });
      }
      if (!usdc || !viemChain) {
        return fail('npayment', `no EIP-3009 settlement route for ${selection.chain}`, { code: 'unsupported_chain', hint: `real x402 settlement supports: ${Object.keys(USDC).join(', ')}` });
      }

      try {
        const np = await import('n-payment');
        const { createWalletClient, createPublicClient, http } = await import('viem');
        const { privateKeyToAccount } = await import('viem/accounts');

        const { authorization, signature } = decodeProof(proof);
        const auth = np.decodeAuthorizationPayload(authorization);
        const { v, r, s } = np.splitSignature(signature);

        const account = privateKeyToAccount(pk);
        const rpc = process.env[`RPC_URL_${selection.chain.toUpperCase().replace(/-/g, '_')}`];
        const transport = rpc ? http(rpc) : http();
        const wallet = createWalletClient({ account, chain: viemChain, transport });
        const publicClient = createPublicClient({ chain: viemChain, transport });

        const txHash = await wallet.writeContract({
          account,
          chain: viemChain,
          address: usdc,
          abi: np.TRANSFER_WITH_AUTHORIZATION_ABI,
          functionName: 'transferWithAuthorization',
          args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s],
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });

        return ok({ txHash, chain: selection.chain, rail: id, asset: selection.asset, amount });
      } catch (err) {
        return fail('npayment', err instanceof Error ? err.message : String(err), { code: 'settle_failed' });
      }
    },
  };
}

/**
 * Settle a $5 RLUSD payment on XRPL via the T54 x402 facilitator.
 *
 * The buyer signs an XRPL Payment and submits the base64 PAYMENT-SIGNATURE
 * envelope as `proof`; this rail forwards it to the facilitator's `/settle`,
 * which broadcasts + verifies on-ledger (invoice-bound). No facilitator key is
 * held here — the buyer signs, the facilitator relays (n-payment's XRPL design).
 *
 * Security: the buyer echoes their own `accepted` requirements, so before
 * settling we bind them to the merchant's terms (payTo = treasury, asset =
 * RLUSD, amount ≥ price) to prevent underpayment. Returns the same
 * ServiceResult<PaymentReceipt> as the EVM path (Liskov).
 */
async function settleXrplRlusd(
  id: RailId,
  selection: PaymentSelection,
  amount: string,
  proof?: string,
): Promise<ServiceResult<PaymentReceipt>> {
  if (!proof) {
    return fail('npayment', 'missing XRPL x402 payment signature', {
      code: 'no_proof',
      hint: 'submit the base64 PAYMENT-SIGNATURE envelope (signed XRPL Payment) as `proof`',
    });
  }
  const treasury = process.env.XRPL_TREASURY_ADDRESS;
  if (!treasury) {
    return fail('npayment', 'XRPL treasury not configured', { code: 'not_configured', hint: 'set XRPL_TREASURY_ADDRESS' });
  }

  try {
    const np = await import('n-payment');
    const network = selection.chain === 'xrpl-mainnet' ? 'mainnet' : 'testnet';
    const url = process.env.XRPL_FACILITATOR_URL ?? np.defaultFacilitatorUrl(network);

    const env = np.decodePaymentSignatureHeader(proof); // throws on malformed → caught
    const acc = env.accepted;

    // Bind the buyer-echoed requirements to the merchant's terms.
    const assetOk = acc.asset === np.RLUSD_HEX || acc.asset === 'RLUSD';
    if (acc.payTo !== treasury || !assetOk || Number(acc.amount) < Number(amount) - 0.01) {
      return fail('npayment', 'payment requirements mismatch', {
        code: 'settle_failed',
        hint: `payment must deliver ≥ ${amount} RLUSD to ${treasury}`,
      });
    }

    const client = new np.XrplFacilitatorClient(url);
    const r = await client.settle({ paymentPayload: env, paymentRequirements: acc });
    if (!r.success || !r.transaction) {
      return fail('npayment', r.errorReason ?? 'xrpl settlement failed', {
        code: 'settle_failed',
        hint: 'facilitator rejected the payment; check the signed blob, invoice binding and RLUSD trustline',
      });
    }
    return ok({ txHash: r.transaction, chain: selection.chain, rail: id, asset: selection.asset, amount, payer: r.payer });
  } catch (err) {
    return fail('npayment', err instanceof Error ? err.message : String(err), { code: 'settle_failed' });
  }
}
