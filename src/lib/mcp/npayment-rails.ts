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
    async settle({ selection, amount, tier, proof }): Promise<ServiceResult<PaymentReceipt>> {
      // XRPL/RLUSD settles through the T54 x402 facilitator, not EIP-3009.
      if (selection.chain.startsWith('xrpl')) {
        return settleXrplRlusd(id, selection, amount, tier, proof);
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
 * Settle a $5 RLUSD payment on XRPL via the T54 x402 facilitator, OR (2026-08-10,
 * xrpl-rlusd-settlement-gap-feedback PRD 02/03) via an already-submitted
 * transaction hash the caller signed and broadcast directly themselves.
 *
 * `proof` disambiguation (PRD 02's fix — previously undocumented, a genuine
 * source of confusion): a bare 64-hex-char string, or JSON `{"txHash":"..."}`,
 * routes to settleXrplAlreadySubmitted() below — an independent on-ledger
 * verification path that never touches the T54 facilitator at all. Anything
 * else is attempted as the pre-broadcast PAYMENT-SIGNATURE envelope via
 * np.decodePaymentSignatureHeader(), the ORIGINAL (and still fully supported,
 * byte-identical) path documented below.
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
const TXHASH_SHAPE = /^[A-Fa-f0-9]{64}$/;

async function settleXrplRlusd(
  id: RailId,
  selection: PaymentSelection,
  amount: string,
  tier: string,
  proof?: string,
): Promise<ServiceResult<PaymentReceipt>> {
  if (!proof) {
    return fail('npayment', 'missing XRPL x402 payment signature', {
      code: 'no_proof',
      hint: 'submit the base64 PAYMENT-SIGNATURE envelope (signed XRPL Payment) as `proof`, or JSON.stringify({txHash}) if you already submitted the transaction directly',
    });
  }

  // PRD 02/03 fix: detect an already-submitted-tx-hash proof BEFORE ever
  // attempting to decode it as a facilitator-relay envelope. Two accepted
  // shapes: a bare 64-hex-char string, or JSON `{"txHash": "..."}`.
  const trimmed = proof.trim();
  let txHash: string | undefined;
  if (TXHASH_SHAPE.test(trimmed)) {
    txHash = trimmed;
  } else if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { txHash?: unknown };
      if (typeof parsed.txHash === 'string' && TXHASH_SHAPE.test(parsed.txHash)) {
        txHash = parsed.txHash;
      }
    } catch {
      // Not JSON at all — fall through to the envelope path below, which
      // will produce its own (generic) decode-failure error if this also
      // isn't a valid base64 envelope. Not a txHash-shaped input, so no
      // wrong_proof_shape hint here — that hint is reserved for the specific
      // "this looks like a bare tx hash" case.
    }
  }
  if (txHash) {
    return settleXrplAlreadySubmitted(id, selection, amount, tier, txHash);
  }

  const treasury = process.env.XRPL_TREASURY_ADDRESS;
  if (!treasury) {
    return fail('npayment', 'XRPL treasury not configured', { code: 'not_configured', hint: 'set XRPL_TREASURY_ADDRESS' });
  }

  try {
    const np = await import('n-payment');
    const network = selection.chain === 'xrpl-mainnet' ? 'mainnet' : 'testnet';
    const url = process.env.XRPL_FACILITATOR_URL ?? np.defaultFacilitatorUrl(network);

    let env: ReturnType<typeof np.decodePaymentSignatureHeader>;
    try {
      env = np.decodePaymentSignatureHeader(proof);
    } catch (decodeErr) {
      // PRD 02 fix: a bare-hex-looking string that somehow didn't match
      // TXHASH_SHAPE above (e.g. wrong length) still gets a more specific
      // hint than the generic catch-all below, since the most likely cause
      // of a decode failure on an XRPL proof is exactly this class of
      // mistake — submitting a transaction identifier instead of a
      // pre-broadcast signature envelope.
      if (/^[A-Fa-f0-9]+$/.test(trimmed) && trimmed.length >= 32) {
        return fail('npayment', 'malformed XRPL payment signature envelope', {
          code: 'wrong_proof_shape',
          hint: 'this looks like an XRPL transaction hash, not a facilitator-relay signature envelope. If you already submitted this transaction directly, submit proof as JSON: {"txHash":"..."}',
        });
      }
      throw decodeErr;
    }
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

/**
 * Settle via an ALREADY-SUBMITTED XRPL transaction hash (2026-08-10,
 * xrpl-rlusd-settlement-gap-feedback PRD 03). The caller signed and
 * broadcast a real Payment directly to rippled themselves (e.g. via
 * rpc.submitAndWait(), the exact pattern scripts/demo-t54-rlusd-dream-cycle.ts
 * demonstrates) — this path independently re-verifies that transaction
 * on-ledger before granting a paid session, NEVER trusting the caller's own
 * claim about what the transaction contains, and never touching the T54
 * facilitator at all (this is a fundamentally different, self-contained
 * verification path from settleXrplRlusd()'s envelope-relay flow above).
 *
 * Security posture matches the envelope path's own rigor exactly: real
 * on-chain read (validated + tesSUCCESS + correct destination + correct
 * asset + amount >= price), PLUS replay protection (a given txHash can only
 * ever unlock ONE paid session — see mcp_xrpl_settled_txs in db.ts). The
 * replay-check row is inserted ONLY after verification succeeds, so a
 * failed/invalid attempt never poisons the table.
 */
async function settleXrplAlreadySubmitted(
  id: RailId,
  selection: PaymentSelection,
  amount: string,
  tier: string,
  txHash: string,
): Promise<ServiceResult<PaymentReceipt>> {
  const treasury = process.env.XRPL_TREASURY_ADDRESS;
  if (!treasury) {
    return fail('npayment', 'XRPL treasury not configured', { code: 'not_configured', hint: 'set XRPL_TREASURY_ADDRESS' });
  }

  const { withClient } = await import('../db');

  // Replay check FIRST — short-circuits before any on-chain RPC call at all
  // for an already-redeemed hash (cheaper, and avoids re-verifying a
  // transaction we've already accepted once).
  const alreadyRedeemed = await withClient(async (client) => {
    const { rows } = await client.query<{ tx_hash: string }>(
      `SELECT tx_hash FROM mcp_xrpl_settled_txs WHERE tx_hash = $1 AND expires_at > NOW() LIMIT 1`,
      [txHash],
    );
    return rows.length > 0;
  });
  if (alreadyRedeemed) {
    return fail('npayment', 'this transaction hash has already been redeemed for a settlement', {
      code: 'already_redeemed',
      hint: 'each on-chain transaction can only unlock one paid session; submit a new payment to unlock another',
    });
  }

  try {
    const np = await import('n-payment');
    const network = selection.chain === 'xrpl-mainnet' ? 'mainnet' : 'testnet';
    const wsUrl = network === 'mainnet' ? 'wss://xrplcluster.com' : 'wss://s.altnet.rippletest.net:51233';
    const connection = new np.XrplConnection(wsUrl);
    const rpc = await connection.getClient();

    // Real, independent on-ledger verification — never trust the caller's
    // claim about what this transaction contains. Mirrors
    // scripts/demo-t54-rlusd-dream-cycle.ts's own verification pattern
    // exactly (validated + tesSUCCESS + re-derive everything from the RPC
    // response, not from caller-supplied fields).
    //
    // Root-cause note (2026-08-10, found via this fix's own live-testnet
    // verification, not assumed from docs): rippled's `tx` command response
    // shape differs by API version. api_version 2 (the client default for
    // the installed xrpl/n-payment versions) nests Account/Destination/
    // Amount under `result.tx_json`, while `validated`/`meta` stay
    // top-level; api_version 1 puts Account/Destination/Amount directly on
    // `result`. Read BOTH locations defensively (tx_json first, since
    // that's the confirmed-real shape from a live testnet response) rather
    // than assuming either — this is exactly the "verify one layer deeper
    // than a design doc/PRD's own code sketch" pattern this project's own
    // lessons-learned file documents repeatedly (the xrplAmendments
    // RPC-method mismatch, the resources.ts matcher collision, etc.).
    const txResult = await rpc.request({ command: 'tx', transaction: txHash } as never) as {
      result: {
        validated?: boolean;
        Destination?: string;
        Account?: string;
        Amount?: { currency?: string; issuer?: string; value?: string } | string;
        meta?: { TransactionResult?: string; delivered_amount?: { currency?: string; value?: string } | string };
        tx_json?: {
          Destination?: string;
          Account?: string;
          Amount?: { currency?: string; issuer?: string; value?: string } | string;
        };
      };
    };
    await connection.disconnect();

    const result = txResult.result;
    const destination = result.tx_json?.Destination ?? result.Destination;
    const account = result.tx_json?.Account ?? result.Account;
    const rawAmount = result.tx_json?.Amount ?? result.Amount;
    const engineResult = result.meta?.TransactionResult;
    if (result.validated !== true || engineResult !== 'tesSUCCESS') {
      return fail('npayment', `transaction not validated/successful on-ledger (validated=${result.validated}, result=${engineResult ?? 'unknown'})`, {
        code: 'settle_failed',
        hint: 'the referenced transaction must be validated with engine result tesSUCCESS',
      });
    }
    if (destination !== treasury) {
      return fail('npayment', 'payment destination does not match merchant treasury', {
        code: 'settle_failed',
        hint: `transaction must pay ${treasury}, not ${destination}`,
      });
    }

    // Prefer meta.delivered_amount (the ledger's own record of what was
    // ACTUALLY delivered, accounting for partial payments / DeliverMax
    // quirks) over the raw Amount field the transaction requested.
    const delivered = result.meta?.delivered_amount ?? rawAmount;
    const deliveredValue = typeof delivered === 'object' ? delivered?.value : undefined;
    const deliveredCurrency = typeof delivered === 'object' ? delivered?.currency : undefined;
    const assetOk = deliveredCurrency === np.RLUSD_HEX || deliveredCurrency === 'RLUSD' || deliveredCurrency === np.RLUSD_CURRENCY;
    if (!assetOk || !deliveredValue || Number(deliveredValue) < Number(amount) - 0.01) {
      return fail('npayment', 'delivered payment does not meet the required RLUSD amount', {
        code: 'settle_failed',
        hint: `transaction must deliver >= ${amount} RLUSD to ${treasury}`,
      });
    }

    // Claim AFTER successful verification — never before. ON CONFLICT DO
    // NOTHING mirrors ownership.ts's claimOrCheckOwnership() race-safety
    // discipline: two concurrent redemption attempts for the same txHash
    // never both "win."
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 10).toISOString(); // 10y — see doc comment above: "never redeemable twice," not a TTL cache
    const claimed = await withClient(async (client) => {
      const { rowCount } = await client.query(
        `INSERT INTO mcp_xrpl_settled_txs (tx_hash, chain, tier, expires_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [txHash, selection.chain, tier, expiresAt],
      );
      return (rowCount ?? 0) > 0;
    });
    if (claimed === false) {
      // Lost a genuine race against a concurrent redemption of the same
      // txHash — the other caller's claim landed first.
      return fail('npayment', 'this transaction hash has already been redeemed for a settlement', {
        code: 'already_redeemed',
        hint: 'each on-chain transaction can only unlock one paid session; submit a new payment to unlock another',
      });
    }

    return ok({ txHash, chain: selection.chain, rail: id, asset: selection.asset, amount, payer: account });
  } catch (err) {
    return fail('npayment', err instanceof Error ? err.message : String(err), { code: 'settle_failed' });
  }
}
