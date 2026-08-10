#!/usr/bin/env node
/**
 * scripts/xrpl-live-submit-helper.mjs
 * -------------------------------------
 * Standalone helper for tests/mcp-xrpl-settlement.test.ts's Tier 2/3 live
 * tests. Submits a real, signed XRPL Payment directly to rippell
 * (testnet or mainnet) and prints the result as JSON on stdout.
 *
 * Why this exists as a SEPARATE process rather than inline in the test file:
 * n-payment's XrplWallet -> ripple-keypairs -> @noble/curves wallet key
 * derivation throws `"secretKey" expected Uint8Array of length 32, got
 * type=object` when run inside this repo's default Vitest environment
 * (jsdom, per vitest.config.ts) — confirmed via a standalone `node -e`
 * script using the exact same n-payment APIs succeeding OUTSIDE Vitest,
 * isolating the failure to jsdom's environment specifically, not the
 * wallet/seed/derivation logic itself. Overriding the test file's own
 * Vitest environment to `node` is not viable either — this repo's shared
 * tests/setup.ts unconditionally references `window` (jsdom-only), so a
 * per-file `node` override breaks that global setup file instead.
 *
 * This script sidesteps the conflict entirely: wallet signing + real
 * on-chain submission happens here, in a genuine Node.js process with no
 * jsdom involved at all — mirroring scripts/demo-t54-rlusd-dream-cycle.ts's
 * own working live-mode logic almost exactly. The Vitest test then only
 * exercises the SETTLEMENT/verification code path (RPC reads only, no
 * wallet signing), which does not hit this conflict.
 *
 * Usage: node scripts/xrpl-live-submit-helper.mjs <network> <treasury> <amount>
 *   network: testnet | mainnet
 * Reads RLUSD_DEMO_SEED from process.env (caller is expected to have
 * sourced scripts/.env.rlusd-demo already).
 * Prints {"ok":true,"txHash":"...","payerAddress":"..."} or
 * {"ok":false,"error":"..."} as the ONLY line on stdout.
 */
const network = process.argv[2];
const treasury = process.argv[3];
const amount = process.argv[4];
const seed = process.env.RLUSD_DEMO_SEED;

if (!network || !treasury || !amount || !seed) {
  console.log(JSON.stringify({ ok: false, error: 'usage: node xrpl-live-submit-helper.mjs <testnet|mainnet> <treasury> <amount>, with RLUSD_DEMO_SEED set' }));
  process.exit(1);
}

(async () => {
  const np = await import('n-payment');
  const wsUrl = network === 'mainnet' ? 'wss://xrplcluster.com' : 'wss://s.altnet.rippletest.net:51233';
  const connection = new np.XrplConnection(wsUrl);
  const rpc = await connection.getClient();
  const issuer = np.getRlusdIssuer(network);
  const wallet = new np.XrplWallet({ seed });
  const payerAddress = await wallet.getAddress();

  const preflight = await np.readAccountState(connection, payerAddress, { issuer, fresh: true });
  if (Number(preflight.rlusdBalance) < Number(amount)) {
    await connection.disconnect();
    console.log(JSON.stringify({ ok: false, error: `payer ${payerAddress} holds ${preflight.rlusdBalance} RLUSD, needs ${amount}` }));
    process.exit(1);
  }

  const draft = {
    TransactionType: 'Payment',
    Account: payerAddress,
    Destination: treasury,
    Amount: { currency: np.RLUSD_CURRENCY, issuer, value: amount },
  };
  const filled = await rpc.autofill(draft);
  const signed = await wallet.sign(filled);
  const submitResult = await rpc.submitAndWait(signed.tx_blob);
  const engineResult = submitResult.result.meta?.TransactionResult;
  const validated = submitResult.result.validated === true;
  await connection.disconnect();

  if (!validated || engineResult !== 'tesSUCCESS') {
    console.log(JSON.stringify({ ok: false, error: `submission did not succeed: validated=${validated}, result=${engineResult}` }));
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, txHash: submitResult.result.hash, payerAddress }));
})().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
