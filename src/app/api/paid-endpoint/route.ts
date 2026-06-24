import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/paid-endpoint
 * -------------------
 * Emits the canonical x402 paywall contract.
 *
 *   Without X-Payment header   → 402 + WWW-Authenticate: x402-USDC
 *   With   X-Payment header    → 200 (mock mode skips signature verify; real mode delegates to n-payment/middleware)
 *
 * The wire contract here is identical to what n-payment v0.29.1 createPaywall() emits, so any agent
 * that can pay one can pay the other. In Sprint 3 we swap this for a direct import of n-payment.
 */

const PAY_TO = process.env.PAY_TO_ADDRESS ?? '0x0000000000000000000000000000000000000000';
const PRICE_MICRO = process.env.PAYMENT_PRICE_MICRO_USDC ?? '10000';
const CHAIN = process.env.PAYMENT_CHAIN ?? 'base-sepolia';

export async function GET(req: NextRequest) {
  const payment = req.headers.get('x-payment');

  if (!payment) {
    return new Response(JSON.stringify({ error: 'payment_required', accept: 'x402-USDC' }), {
      status: 402,
      headers: {
        'www-authenticate': `x402-USDC realm="hypermove.dev", chain="${CHAIN}", payTo="${PAY_TO}", price="${PRICE_MICRO}"`,
        'content-type': 'application/json',
        'x-x402-version': '1',
      },
    });
  }

  // Real mode would verify EIP-3009 here via n-payment/middleware.verify().
  // Mock mode accepts any header value — sufficient for the homepage cinematic.
  return Response.json({
    ok: true,
    amount_usdc: Number(PRICE_MICRO),
    chain: CHAIN,
    receipt: { tx_hash: '0xfa6c1c2e5d0a87f7b9a9eaf6c0f2a8a4cf18e3e9d3c7a52a9b4d3f9c1e4f8b21e' },
    paid_at: new Date().toISOString(),
  });
}

export const HEAD = GET;
