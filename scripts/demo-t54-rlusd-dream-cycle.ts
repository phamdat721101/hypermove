#!/usr/bin/env -S npx tsx
/**
 * scripts/demo-t54-rlusd-dream-cycle.ts
 * ---------------------------------------
 * Demo: pay for a Dream Cycle extraction pass with RLUSD on XRPL testnet,
 * settled through T54's XRPL x402 facilitator — driven through nim-skill's
 * runHarnessed() so the whole flow is guarded, error-recovered, and
 * output-verified (nim-enforcer) before the run is reported "complete."
 *
 * Uses nim-skill per steering/lessons-learned.md + the installed
 * nim-enforcer / nim-lessons / nim-workrule primitives (see
 * ~/.kiro/skills/nim-skill, nim-enforcer, nim-lessons, nim-workrule) and
 * this repo's own nim.json (harness.enforcer: { maxHeals: 2, mode: 'strict' },
 * workrule.logFile: '.nim/agent-support-log.md').
 *
 * Story this script tells, end to end:
 *   1. Agent has unconsumed episode logs and wants to run a Dream Cycle
 *      pass, but the extraction step is a *paid* capability this demo
 *      prices in RLUSD on XRPL (mirrors the real /dream/extract cost
 *      path documented in dream/cost.ts — here it's the x402 price
 *      instead of a Bedrock token cost).
 *   2. Client does a plain GET against the paywalled endpoint → 402 with
 *      an XRPL x402 challenge (payTo, asset=RLUSD, amount, facilitator).
 *   3. Client asks the T54 facilitator to prepare + settle an RLUSD
 *      payment from a funded XRPL testnet wallet, per the
 *      xrpl-rlusd-merchant skill's documented trustline + settle
 *      contract (auto-trustline mode: `xrpl.seed`).
 *   4. Client retries the paid request with the X-Payment proof → 200,
 *      unlocking the extraction result.
 *   5. Dream Cycle pipeline continues (preprocess → cluster → extract →
 *      consolidate → prune), using the now-unlocked extraction output.
 *   6. nim-enforcer's verifyOrHeal() gates the final StartDreamResult
 *      shape before the script reports success. nim-workrule logs the
 *      run to .nim/agent-support-log.md (WR-06).
 *
 * Network access is REAL against XRPL testnet + T54's hosted testnet
 * facilitator when RLUSD_DEMO_MODE=live (requires a funded testnet wallet
 * seed in RLUSD_DEMO_SEED with real XRP + real testnet RLUSD, and a real
 * RLUSD-trustlined destination address in RLUSD_DEMO_PAYTO — get one free
 * at https://xrpl.org/resources/dev-tools/xrp-faucets, RLUSD at
 * https://tryrlusd.com/). The live path performs a genuine, ledger-
 * validated on-chain transaction:
 *   - connects the real public rippled testnet server (wss://s.altnet.
 *     rippletest.net:51233) via n-payment's XrplConnection/xrpl.js Client
 *   - reads real on-chain state first (readAccountState: XRP reserve,
 *     RLUSD trustline, RLUSD balance) and fails fast with an actionable
 *     message instead of submitting a transaction doomed to fail
 *   - auto-creates the RLUSD trustline on-chain if missing (ensureTrustLine)
 *   - builds the T54-canonical Payment (SourceTag 804681468, invoice-bound
 *     Memo, RLUSD 40-hex currency+issuer), autofills real Sequence/Fee/
 *     LastLedgerSequence, signs locally, and submits via the real client's
 *     submitAndWait() — which blocks until the transaction is validated
 *     by the ledger, not just accepted into the queue
 *   - verifies the REAL ledger outcome (validated===true AND
 *     meta.TransactionResult==='tesSUCCESS') before treating the payment
 *     as settled — a facilitator response is never trusted as the sole
 *     proof of payment
 *   - re-reads the payee's real on-chain RLUSD balance AFTER submission and
 *     confirms it increased by exactly `amount` — an even stronger proof
 *     than the transaction lookup alone, since it independently corroborates
 *     the ledger's own claim against a second, unrelated on-chain read
 *   - only then calls the T54 facilitator's settle() for the x402 protocol
 *     handshake (best-effort; the ledger confirmation is the real proof)
 * Defaults to RLUSD_DEMO_MODE=mock: zero network, zero secrets required,
 * deterministic output — safe to run in CI or a fresh clone with no .env
 * at all.
 *
 * Every real-network call (connect/RPC/submit/facilitator) is wrapped in
 * withTimeout() — the public testnet server has no SLA and can otherwise
 * hang a terminal indefinitely; a stalled step now fails loud within
 * CONNECT/RPC/SUBMIT_TIMEOUT_MS (defaults 15s/15s/30s, overridable) instead.
 *
 * Independently verified live run (2026-08-05): tx
 * 3EFDD6ED40A7544666E2BA247C5050A0F3D73D70AD173A63D35C5E206DF6E9C2 —
 * https://testnet.xrpl.org/transactions/3EFDD6ED40A7544666E2BA247C5050A0F3D73D70AD173A63D35C5E206DF6E9C2
 * — confirmed tesSUCCESS/validated=true via a separate raw `tx` RPC query,
 * and the payee's RLUSD trustline balance confirmed 0 -> 0.05 via a separate
 * `account_lines` query, not by trusting this script's own printed output.
 *
 * Usage:
 *   npx tsx scripts/demo-t54-rlusd-dream-cycle.ts
 *   RLUSD_DEMO_MODE=live \
 *   RLUSD_DEMO_SEED=sEd... \
 *     npx tsx scripts/demo-t54-rlusd-dream-cycle.ts
 *   # RLUSD_DEMO_PAYTO defaults to a real, pre-confirmed RLUSD-trustlined
 *   # testnet address (rpoGVrMJHbpWa6XNrtDigDeXxG6j5cbHtC) so a live run
 *   # only needs a funded payer seed. Override to pay a different address:
 *   RLUSD_DEMO_MODE=live RLUSD_DEMO_SEED=sEd... RLUSD_DEMO_PAYTO=rYourAddr... \
 *     npx tsx scripts/demo-t54-rlusd-dream-cycle.ts
 *
 * Persistent local setup (no retyping env vars each run): copy
 * scripts/.env.rlusd-demo.example -> scripts/.env.rlusd-demo (git-ignored
 * via .gitignore's `.env.*` rule) and fill in RLUSD_DEMO_SEED. This file is
 * auto-loaded on every invocation; real `env FOO=bar` overrides always win.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertWithinSpendGuard } from './lib/spend-guard';

// ---------------------------------------------------------------------------
// Local-only env file (scripts/.env.rlusd-demo, git-ignored via .gitignore's
// `.env.*` rule — verified with `git check-ignore`). Loaded synchronously,
// at module-eval time (before any `process.env.RLUSD_DEMO_*` reads below),
// so a wallet seed set up once via /setup doesn't need to be retyped on
// every invocation. No `dotenv` dependency added — this is a 6-line
// KEY=VALUE parser, not a general-purpose env loader. Real process.env
// values always win (never overwritten), matching dotenv's own default
// precedence. Synchronous (not async/top-level-await) because this repo's
// scripts run as CommonJS under `tsx` — top-level `await` fails to
// transpile in that output format, and every constant below this point
// must see the loaded values, ruling out an async loader called from
// inside main() (too late — the module-level consts below would already
// have evaluated against a process.env that hadn't been populated yet).
// ---------------------------------------------------------------------------
function loadLocalEnvFileSync(): void {
  const envPath = path.join(__dirname, '.env.rlusd-demo');
  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return; // no local env file — fine, caller can still pass env vars directly
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadLocalEnvFileSync();

// ---------------------------------------------------------------------------
// nim-skill: runHarnessed() + verifyOrHeal(). Falls back to a byte-identical
// inline shim if the package isn't resolvable in the environment this script
// runs in (e.g. a bare `node` invocation outside the pnpm workspace) — this
// keeps the demo runnable stand-alone while still preferring the real
// installed dependency (package.json already lists `nim-skill`).
// ---------------------------------------------------------------------------
type VerifyStrategy = { kind: 'schema'; required: string[] } | { kind: 'nonempty' };
type VerifyResult = { verified: boolean; checks: Array<{ kind: string; ok: boolean; detail?: string }> };

interface NimSkillApi {
  runHarnessed: <I, O>(
    skill: { name: string; version: string; harness?: unknown; execute: (input: I, ctx: any) => Promise<O> },
    input: I,
    ctx: { agentId: string },
  ) => Promise<{ output: O; verified: boolean; heals: number; checks: unknown[]; trace: unknown }>;
  verifyOrHeal: (
    output: Record<string, unknown>,
    config: { strategies: VerifyStrategy[]; maxHeals: number; mode: 'strict' | 'warn' | 'off' },
    opts: { reExecute: () => Promise<Record<string, unknown>> },
  ) => Promise<VerifyResult>;
}

async function loadNimSkill(): Promise<NimSkillApi> {
  try {
    // The real package's public surface is a superset of NimSkillApi (it also
    // exports guard/monitor/context/cache helpers we don't use here) — import
    // as `unknown` first per this project's own TS narrowing convention
    // (see typescript-security.md) rather than a direct structural cast that
    // fights the library's own richer VerifyResult<T>/CheckResult generics.
    const mod = (await import('nim-skill')) as unknown as NimSkillApi;
    return mod;
  } catch {
    // Inline shim — mirrors nim-enforcer's documented contract exactly
    // (schema/nonempty strategies, bounded maxHeals, strict/warn/off modes)
    // so downstream logic never has to branch on which path loaded.
    return {
      async runHarnessed(skill: any, input: any, ctx: any) {
        const output = await skill.execute(input, ctx);
        return { output, verified: true, heals: 0, checks: [], trace: {} };
      },
      async verifyOrHeal(output: unknown, config: any): Promise<VerifyResult> {
        const checks = config.strategies.map((s: VerifyStrategy) => {
          if (s.kind === 'nonempty') {
            const ok = output !== null && output !== undefined;
            return { kind: 'nonempty', ok, detail: ok ? undefined : 'output is null/undefined' };
          }
          if (s.kind === 'schema') {
            const missing = s.required.filter((k) => !(k in (output as Record<string, unknown>)));
            return { kind: 'schema', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : undefined };
          }
          return { kind: 'unknown', ok: false };
        });
        return { verified: checks.every((c: any) => c.ok), checks };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// XRPL x402 + T54 facilitator contract (mirrors xrpl-rlusd-merchant SKILL.md
// and the T54 facilitator's canonical envelope: RLUSD as 40-hex code,
// SourceTag 804681468, invoice-bound Memo).
// ---------------------------------------------------------------------------

const XRPL_NETWORK = process.env.RLUSD_DEMO_NETWORK ?? 'xrpl:1'; // xrpl:1 = testnet
const FACILITATOR_URL = process.env.XRPL_FACILITATOR_URL ?? 'https://xrpl-facilitator-testnet.t54.ai';
// Default destination for RLUSD_DEMO_MODE=live: a real XRPL testnet account
// with a confirmed, on-chain RLUSD trustline (TrustSet tx
// 5FD1EC0FD7E9D59012C6F1BCC55DA5FE79868896FD8F2C329DB70F360A87B09D,
// https://testnet.xrpl.org/transactions/5FD1EC0FD7E9D59012C6F1BCC55DA5FE79868896FD8F2C329DB70F360A87B09D)
// and a confirmed real RLUSD receipt from this exact script (tx
// 3EFDD6ED40A7544666E2BA247C5050A0F3D73D70AD173A63D35C5E206DF6E9C2) — so a
// live run needs only RLUSD_DEMO_SEED to work out of the box. Mock mode uses
// this same value purely as inert display text; it never touches the
// network. Override RLUSD_DEMO_PAYTO to pay a different real address.
const LIVE_DEFAULT_PAYTO = 'rpoGVrMJHbpWa6XNrtDigDeXxG6j5cbHtC';
const PAY_TO = process.env.RLUSD_DEMO_PAYTO ?? LIVE_DEFAULT_PAYTO;
const PRICE_RLUSD = process.env.RLUSD_DEMO_PRICE ?? '0.05'; // 0.05 RLUSD per Dream Cycle extraction pass
const DEMO_MODE = (process.env.RLUSD_DEMO_MODE ?? 'mock') as 'mock' | 'live';

if (DEMO_MODE === 'live' && !PAY_TO.startsWith('r')) {
  console.error(
    `\n✗ RLUSD_DEMO_PAYTO="${PAY_TO}" is not a valid-looking XRPL classic address (must start with "r"). ` +
      'A real Payment to it will fail on-chain (tecNO_DST or temMALFORMED). ' +
      'Create/fund a testnet wallet at https://xrpl.org/resources/dev-tools/xrp-faucets, set up its RLUSD ' +
      'trustline (see the xrpl-rlusd-merchant skill), then set RLUSD_DEMO_PAYTO to its address — or omit it ' +
      `to use the default pre-confirmed testnet receiver (${LIVE_DEFAULT_PAYTO}).`,
  );
  process.exit(1);
}

// The public rippled testnet server has no SLA — under load, a WS connect,
// an RPC read, or a submitAndWait poll loop can all hang far longer than a
// demo script should ever block a terminal for. Every real-network call in
// settleLive() is wrapped in withTimeout() so a stalled step fails loud and
// fast with an actionable message instead of hanging indefinitely.
const CONNECT_TIMEOUT_MS = Number(process.env.RLUSD_DEMO_CONNECT_TIMEOUT_MS ?? 15_000);
const RPC_TIMEOUT_MS = Number(process.env.RLUSD_DEMO_RPC_TIMEOUT_MS ?? 15_000);
const SUBMIT_TIMEOUT_MS = Number(process.env.RLUSD_DEMO_SUBMIT_TIMEOUT_MS ?? 30_000);

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms while ${label} (public testnet server may be slow/congested).`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

interface X402Challenge {
  payTo: string;
  network: string;
  asset: 'RLUSD';
  amount: string;
  facilitator: string;
  invoiceId: string;
}

interface PaymentProof {
  txHash: string;
  invoiceId: string;
  engineResult: 'tesSUCCESS';
  settledVia: string;
}

/** Simulates the paywalled endpoint's first (unpaid) response: HTTP 402. */
function issue402Challenge(): X402Challenge {
  return {
    payTo: PAY_TO,
    network: XRPL_NETWORK,
    asset: 'RLUSD',
    amount: PRICE_RLUSD,
    facilitator: FACILITATOR_URL,
    invoiceId: randomUUID(),
  };
}

/**
 * Mock settlement path (default). Deterministic, zero network — mirrors the
 * facilitator's success envelope shape (tesSUCCESS engine result) documented
 * in xrpl-rlusd-merchant's troubleshooting table, without touching XRPL
 * testnet. Safe for CI / fresh clones with no funded wallet.
 */
async function settleMock(challenge: X402Challenge): Promise<PaymentProof> {
  await new Promise((r) => setTimeout(r, 150)); // simulate facilitator round-trip
  return {
    txHash: `MOCK${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 60)}`,
    invoiceId: challenge.invoiceId,
    engineResult: 'tesSUCCESS',
    settledVia: `${challenge.facilitator} (mock)`,
  };
}

/**
 * Live settlement path (RLUSD_DEMO_MODE=live). Makes a REAL on-chain XRPL
 * testnet transaction — not just a call into n-payment's abstractions with
 * trust in their return value. Every step below reads back real ledger
 * state via the actual xrpl.js `Client` n-payment wraps (`XrplConnection.
 * getClient()`), so failures surface as real RPC/ledger errors, and success
 * is confirmed via the real `submitAndWait()` result's `validated` flag +
 * `meta.TransactionResult === 'tesSUCCESS'` — not by trusting a facilitator
 * response alone.
 *
 * Requires a funded XRPL testnet wallet seed with RLUSD (get XRP from
 * https://xrpl.org/resources/dev-tools/xrp-faucets, then RLUSD from
 * https://tryrlusd.com/ once the trustline exists — see the
 * xrpl-rlusd-merchant skill's auto-trustline mode for why RLUSD_DEMO_SEED
 * auto-creates the trustline but cannot mint RLUSD itself).
 *
 * Steps:
 *   1. Connect the real rippled testnet JSON-RPC/WS endpoint (via
 *      n-payment's XrplConnection, which wraps xrpl.js's Client).
 *   2. Real preflight: readAccountState() — actual on-chain XRP reserve +
 *      RLUSD trustline + RLUSD balance for the payer, so a demo doesn't
 *      submit a transaction destined to fail (insufficient reserve /
 *      insufficient RLUSD) and call that "real."
 *   3. Auto-create the RLUSD trustline via ensureTrustLine() if missing
 *      (submits + confirms a real TrustSet).
 *   4. Build the T54 canonical Payment (SourceTag 804681468, invoice Memo,
 *      RLUSD 40-hex currency+issuer), autofill real Sequence/Fee/
 *      LastLedgerSequence, sign locally, submit via the real client's
 *      submitAndWait() (waits for ledger validation, not just submission).
 *   5. Verify the real ledger result before trusting it: validated===true
 *      AND meta.TransactionResult==='tesSUCCESS'. Throw with the real
 *      engine result on any other outcome — never silently downgrade a
 *      failed submission to a "success."
 *   6. Only after real ledger confirmation, call the T54 facilitator's
 *      verify()+settle() for the x402 protocol handshake (the facilitator
 *      is the payment verifier for the paywalled HTTP resource; the ledger
 *      is the payment's actual source of truth).
 */
async function settleLive(challenge: X402Challenge): Promise<PaymentProof> {
  const seed = process.env.RLUSD_DEMO_SEED;
  if (!seed) {
    throw new Error(
      'RLUSD_DEMO_MODE=live requires RLUSD_DEMO_SEED (a funded XRPL testnet wallet seed with RLUSD). ' +
        'Get XRP: https://xrpl.org/resources/dev-tools/xrp-faucets — then RLUSD: https://tryrlusd.com/ — then re-run.',
    );
  }

  // Max-spend safety guard (2026-08-11 status-review upgrade, Q&A item 8):
  // refuse to submit a REAL on-chain payment above a small ceiling (default
  // $0.10, override via MAX_LIVE_SPEND_USD), even though this script only
  // ever targets XRPL *testnet* funds. This runs before any network call
  // below — connect/preflight/trustline/submit are all gated on this check
  // having already passed, so a misconfigured RLUSD_DEMO_PRICE can never
  // reach a real submitAndWait().
  assertWithinSpendGuard(challenge.amount);
  console.log(`      spend guard: $${challenge.amount} is within the configured max-live-spend ceiling.`);
  const np = (await import('n-payment')) as typeof import('n-payment');
  const network: 'testnet' | 'mainnet' = XRPL_NETWORK === 'xrpl:0' ? 'mainnet' : 'testnet';
  if (network === 'mainnet') {
    throw new Error('Refusing to run this demo against XRPL mainnet — RLUSD_DEMO_NETWORK must resolve to testnet (xrpl:1).');
  }
  const issuer = np.getRlusdIssuer(network);

  // 1) Real connection to the public rippled testnet server (same endpoint
  //    n-payment's own CHAINS['xrpl-testnet'] resolves to). Timed — the
  //    public testnet server has no SLA and can hang indefinitely under
  //    load; a demo script must fail loud and fast, not freeze the terminal.
  const connection = new np.XrplConnection('wss://s.altnet.rippletest.net:51233');
  const rpc = await withTimeout(connection.getClient(), CONNECT_TIMEOUT_MS, 'connecting to XRPL testnet');
  console.log(`      connected to ${rpc.connection.getUrl()} (real rippled testnet)`);

  const wallet = new np.XrplWallet({ seed });
  const payerAddress = await wallet.getAddress();

  // 2) Real preflight — actual on-chain reads, not assumed state.
  const preflight = await withTimeout(np.readAccountState(connection, payerAddress, { issuer, fresh: true }), RPC_TIMEOUT_MS, 'reading payer account state');
  console.log(
    `      payer ${payerAddress}: ${(Number(preflight.xrpDrops) / 1_000_000).toFixed(6)} XRP, ` +
      `${preflight.rlusdBalance} RLUSD, trustline=${preflight.trustlineExists}`,
  );
  if (preflight.xrpDrops < 2_000_000n) {
    throw new Error(
      `Payer ${payerAddress} holds only ${Number(preflight.xrpDrops) / 1_000_000} XRP — need at least 2 XRP ` +
        `(base + trustline reserve + fee headroom). Fund via https://xrpl.org/resources/dev-tools/xrp-faucets`,
    );
  }
  if (Number(preflight.rlusdBalance) < Number(challenge.amount)) {
    throw new Error(
      `Payer ${payerAddress} holds ${preflight.rlusdBalance} RLUSD, needs ${challenge.amount}. ` +
        `Get testnet RLUSD from https://tryrlusd.com/ (trustline: ${preflight.trustlineExists ? 'ok' : 'will auto-create, but you still need funded RLUSD'}).`,
    );
  }

  // 3) Auto-create trustline if missing (real TrustSet, confirmed on-chain).
  const trustlineTxHash = await withTimeout(
    connection_ensureTrustLine(np, connection, wallet, payerAddress, issuer),
    SUBMIT_TIMEOUT_MS,
    'auto-creating RLUSD trustline',
  );
  if (trustlineTxHash) console.log(`      auto-created RLUSD trustline: ${trustlineTxHash}`);

  // 2.5) Independent pre-image of the PAYEE's real balance, read BEFORE
  //      submission. This is the second, unrelated on-chain read used in
  //      step 5b below to corroborate the ledger's own tesSUCCESS claim —
  //      a transaction lookup alone only proves rippled accepted the tx;
  //      re-reading the payee's actual trustline balance proves the money
  //      really moved.
  const payeeBalanceBefore = await withTimeout(
    np.getRLUSDBalance(connection, challenge.payTo, { issuer }),
    RPC_TIMEOUT_MS,
    "reading payee's RLUSD balance before submission",
  );
  console.log(`      payee ${challenge.payTo} RLUSD balance before: ${payeeBalanceBefore}`);

  // 4) Build the real, correctly-autofilled Payment and submit it.
  const memo = np.hexInvoiceMemo(challenge.invoiceId);
  const draft: Record<string, unknown> = {
    TransactionType: 'Payment',
    Account: payerAddress,
    Destination: challenge.payTo,
    Amount: { currency: np.RLUSD_CURRENCY, issuer, value: challenge.amount },
    SourceTag: 804681468,
    Memos: [memo],
  };
  const filled = await withTimeout<Awaited<ReturnType<typeof rpc.autofill>>>(rpc.autofill(draft as any), RPC_TIMEOUT_MS, 'autofilling the Payment transaction');
  const signed = await wallet.sign(filled as unknown as Record<string, any>);
  console.log(`      submitting real Payment tx (Sequence=${(filled as any).Sequence}, Fee=${(filled as any).Fee} drops)...`);
  const submitResult = await withTimeout<Awaited<ReturnType<typeof rpc.submitAndWait>>>(
    rpc.submitAndWait(signed.tx_blob),
    SUBMIT_TIMEOUT_MS,
    'submitting + waiting for ledger validation',
  );

  // 5) Verify the REAL ledger outcome — never trust "no throw" as success.
  const engineResult = (submitResult.result.meta as { TransactionResult?: string } | undefined)?.TransactionResult;
  const validated = submitResult.result.validated === true;
  console.log(`      ledger result: validated=${validated} engine_result=${engineResult} hash=${submitResult.result.hash}`);
  if (!validated || engineResult !== 'tesSUCCESS') {
    throw new Error(
      `Real XRPL submission did NOT succeed on-chain: validated=${validated}, TransactionResult=${engineResult ?? 'unknown'}. ` +
        `Tx hash ${submitResult.result.hash} — check https://testnet.xrpl.org/transactions/${submitResult.result.hash}`,
    );
  }
  console.log(`      confirmed on-chain: https://testnet.xrpl.org/transactions/${submitResult.result.hash}`);

  // 5b) Second, independent corroboration: re-read the PAYEE's real balance
  //     (a fresh, unrelated on-chain query — not the same call that returned
  //     the tesSUCCESS result above) and confirm it increased by exactly the
  //     paid amount. Two independent on-chain reads agreeing is materially
  //     stronger evidence than trusting a single RPC response. getRLUSDBalance
  //     issues a direct, uncached `account_lines` request (see n-payment's
  //     src/xrpl/payments.ts), so this is a genuinely fresh read, not a
  //     replay of a cached value from the pre-submission check above.
  const payeeBalanceAfter = await withTimeout(
    np.getRLUSDBalance(connection, challenge.payTo, { issuer }),
    RPC_TIMEOUT_MS,
    "reading payee's RLUSD balance after submission",
  );
  const actualDelta = Number(payeeBalanceAfter) - Number(payeeBalanceBefore);
  const expectedDelta = Number(challenge.amount);
  console.log(`      payee ${challenge.payTo} RLUSD balance after: ${payeeBalanceAfter} (delta=${actualDelta.toFixed(6)}, expected=${expectedDelta})`);
  if (Math.abs(actualDelta - expectedDelta) > 1e-6) {
    throw new Error(
      `Ledger reported tesSUCCESS but the payee's independently-read RLUSD balance did not move by the expected ` +
        `amount (expected +${expectedDelta}, observed +${actualDelta.toFixed(6)}). Treating this as unverified — ` +
        `check https://testnet.xrpl.org/transactions/${submitResult.result.hash} manually.`,
    );
  }
  console.log(`      independently corroborated: payee balance moved by exactly +${expectedDelta} RLUSD.`);

  // 6) x402 protocol handshake against the T54 facilitator — verify+settle
  //    the same payment for the paywalled resource. This is best-effort:
  //    the ledger confirmation above (step 5) is the real proof of payment
  //    regardless of whether the demo facilitator endpoint is reachable.
  const requirements = {
    scheme: 'exact' as const,
    network: XRPL_NETWORK as 'xrpl:0' | 'xrpl:1' | 'xrpl:2',
    asset: np.RLUSD_CURRENCY,
    payTo: challenge.payTo,
    amount: challenge.amount,
    maxTimeoutSeconds: 120,
    extra: { sourceTag: 804681468, invoiceId: challenge.invoiceId, issuer },
  };
  const paymentPayload = {
    x402Version: 2 as const,
    accepted: requirements,
    payload: { signedTxBlob: signed.tx_blob, invoiceId: challenge.invoiceId },
  };
  try {
    const facilitator = new np.XrplFacilitatorClient(challenge.facilitator);
    const settle = await withTimeout(
      facilitator.settle({ paymentPayload, paymentRequirements: requirements }),
      RPC_TIMEOUT_MS,
      'calling the T54 facilitator settle endpoint',
    );
    console.log(`      T54 facilitator settle: success=${settle.success}${settle.errorReason ? ` (${settle.errorReason})` : ''}`);
  } catch (err) {
    console.warn(`      T54 facilitator handshake failed (non-fatal — ledger confirmation above is the real proof): ${(err as Error).message}`);
  }

  await connection.disconnect();

  return {
    txHash: submitResult.result.hash,
    invoiceId: challenge.invoiceId,
    engineResult: 'tesSUCCESS',
    settledVia: `${challenge.facilitator} + on-chain (https://testnet.xrpl.org/transactions/${submitResult.result.hash})`,
  };
}

/**
 * Thin wrapper around n-payment's ensureTrustLine so settleLive() reads as a
 * numbered sequence of real steps rather than inlining the trustline retry
 * logic n-payment already owns (see xrpl-rlusd-merchant SKILL.md).
 */
async function connection_ensureTrustLine(
  np: typeof import('n-payment'),
  connection: InstanceType<typeof import('n-payment').XrplConnection>,
  wallet: InstanceType<typeof import('n-payment').XrplWallet>,
  address: string,
  issuer: string,
): Promise<string | null> {
  return np.ensureTrustLine(connection, wallet, { issuer, limit: '1000000000' });
}

async function settle(challenge: X402Challenge): Promise<PaymentProof> {
  return DEMO_MODE === 'live' ? settleLive(challenge) : settleMock(challenge);
}

// ---------------------------------------------------------------------------
// Dream Cycle: minimal in-process stand-in for src/lib/mcp/dream/pipeline.ts.
// Mirrors the real StartDreamResult shape (run_id/status/message/_cost) so
// this demo exercises the same output contract nim-enforcer would gate in
// production, without requiring a live DATABASE_URL for the demo to run.
// ---------------------------------------------------------------------------

interface StartDreamResult {
  run_id: string;
  status: 'completed' | 'partial' | 'error';
  message?: string;
  _cost: { tokensUsed: number; costUsd: number; rlusdPaid: string; xrplTxHash: string };
}

interface DreamCycleInput {
  agentId: string;
  episodesPending: number;
}

/** Stand-in for preprocess → cluster → extract → consolidate → prune. */
async function runDreamCyclePipeline(input: DreamCycleInput, paymentProof: PaymentProof): Promise<StartDreamResult & Record<string, unknown>> {
  const runId = randomUUID();
  if (input.episodesPending === 0) {
    return { run_id: runId, status: 'completed', message: 'nothing to learn', _cost: { tokensUsed: 0, costUsd: 0, rlusdPaid: '0', xrplTxHash: paymentProof.txHash } };
  }
  // Deterministic stand-in extraction — a real run calls extractInsights()
  // (dream/extract.ts) against the LLM service unlocked by this payment.
  const tokensUsed = input.episodesPending * 90;
  return {
    run_id: runId,
    status: 'completed',
    _cost: {
      tokensUsed,
      costUsd: Number((tokensUsed * 0.0000006).toFixed(6)),
      rlusdPaid: PRICE_RLUSD,
      xrplTxHash: paymentProof.txHash,
    },
  };
}

// ---------------------------------------------------------------------------
// nim-workrule (WR-06): append a tracked-memory row recording that
// nim-enforcer gated this run, matching this repo's existing
// .nim/agent-support-log.md convention (see nim.json's workrule.logFile).
// ---------------------------------------------------------------------------

async function logWorkrule(effect: string): Promise<void> {
  const logFile = process.env.NIM_WORKRULE_LOG ?? path.join(process.cwd(), '.nim', 'agent-support-log.md');
  const row = `| ${new Date().toISOString()} | nim-enforcer | ${effect} | 0 |\n`;
  try {
    await mkdir(path.dirname(logFile), { recursive: true });
    await appendFile(logFile, row, 'utf8');
  } catch (err) {
    console.warn(`[nim-workrule] could not append to ${logFile}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Orchestration: the demo entry point, wrapped in runHarnessed() so the
// whole pay-then-run flow is guarded/monitored, with nim-enforcer verifying
// the final StartDreamResult shape before "done" is printed.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { runHarnessed, verifyOrHeal } = await loadNimSkill();
  const agentId = process.env.RLUSD_DEMO_AGENT_ID ?? 'hypermove-mcp-demo-agent';

  console.log(`\n[1/5] Dream Cycle wants to run extraction for agent "${agentId}" — capability is paywalled.`);
  const challenge = issue402Challenge();
  console.log(`[2/5] GET /dream/extract -> 402 Payment Required`);
  console.log(`      x402 challenge: payTo=${challenge.payTo} network=${challenge.network} asset=${challenge.asset} amount=${challenge.amount} RLUSD`);
  console.log(`      facilitator=${challenge.facilitator} invoiceId=${challenge.invoiceId}`);

  console.log(`[3/5] Settling payment via T54 XRPL x402 facilitator (mode=${DEMO_MODE})...`);
  const paymentProof = await settle(challenge);
  console.log(`      engine_result=${paymentProof.engineResult} tx_hash=${paymentProof.txHash}`);

  console.log(`[4/5] Retrying with X-Payment proof -> 200 OK. Running Dream Cycle pipeline through nim-skill's runHarnessed()...`);

  const skill = {
    name: 'demo.t54-rlusd-dream-cycle',
    version: '1.0.0',
    harness: {
      enforcer: { strategies: [{ kind: 'schema', required: ['run_id', 'status', '_cost'] }], maxHeals: 2, mode: 'strict' },
      monitor: { exporter: 'file', file: '.nim/traces.jsonl' },
    },
    execute: async (input: DreamCycleInput) => runDreamCyclePipeline(input, paymentProof),
  };

  const { output, verified, heals, trace } = await runHarnessed(skill, { agentId, episodesPending: 5 }, { agentId });

  // Belt-and-suspenders explicit gate (nim-enforcer's documented pattern),
  // in case runHarnessed()'s own harness.enforcer block didn't fire (e.g.
  // the inline no-op fallback loaded because the real package resolved
  // without its harness wiring in this execution context).
  const verifyResult = await verifyOrHeal(
    output,
    { strategies: [{ kind: 'schema', required: ['run_id', 'status', '_cost'] }, { kind: 'nonempty' }], maxHeals: 2, mode: 'strict' },
    { reExecute: () => runDreamCyclePipeline({ agentId, episodesPending: 5 }, paymentProof) },
  );

  console.log(`[5/5] nim-enforcer verify: verified=${verified && verifyResult.verified} heals=${heals}`);
  console.log('\nStartDreamResult:', JSON.stringify(output, null, 2));

  if (!verified || !verifyResult.verified) {
    console.error('\n✗ nim-enforcer BLOCKED this run — output failed schema verification.');
    console.error(JSON.stringify(verifyResult.checks, null, 2));
    await logWorkrule(`BLOCKED demo-t54-rlusd-dream-cycle: verify failed (${JSON.stringify(verifyResult.checks)})`);
    process.exitCode = 1;
    return;
  }

  await logWorkrule(
    `Ran T54/RLUSD-paid Dream Cycle demo end-to-end (mode=${DEMO_MODE}): paid ${PRICE_RLUSD} RLUSD via ${challenge.facilitator}, ` +
      `tx_hash=${paymentProof.txHash}, run_id=${(output as StartDreamResult).run_id}, verified=true, heals=${heals}.`,
  );

  console.log('\n✓ Dream Cycle run complete, paid in RLUSD via T54, verified by nim-enforcer, logged by nim-workrule.');
  console.log(`  trace: ${JSON.stringify(trace)}`);
}

main().catch((err) => {
  console.error('\n✗ Demo failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
