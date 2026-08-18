#!/usr/bin/env -S npx tsx
/**
 * scripts/smoke-live-deployment.ts
 * -----------------------------------
 * Live-deployment smoke test (2026-08-11 dream-cycle-fcc-rlusd-status-review,
 * PRD 03). Re-runs the 5 steps that PRD 03 specified against a real, live
 * hosted MCP deployment, printing a pass/fail line per step plus the
 * deployed commit hash at the top — so a report is always dated to an exact
 * build, per that PRD's stated rationale (multiple prior sessions in the
 * corpus read source code but never bridged that to a live deployment
 * check in the same session).
 *
 * The 5 steps:
 *   1. GET /api/mcp/health — prints commit, deployed_at, and (2026-08-11
 *      PRD 05) real_payments_configured.
 *   2. tools/call submit_episode_log — one well-formed episode for a
 *      throwaway test agent_id.
 *   3. tools/call start_dream — asserts a Dream quote challenge by default;
 *      MCP_SMOKE_RUN_PAID_DREAM=true signs one fresh testnet quote and retries.
 *   4. tools/call get_dream_stats — asserts stage_summaries.preprocessing.
 *      live_unconsumed_count (2026-08-11 Task 2) is present.
 *   5. tools/call payments.settle — tier: 't1_read', chain: 'xrpl-testnet',
 *      a DELIBERATELY invalid proof, expecting a structured rejection (not
 *      a network-level ambiguous error) — confirms gate 1 (network
 *      validation) passes and gates 2/3 correctly reject bad input, WITHOUT
 *      ever reaching a real settlement (asserted explicitly below, not just
 *      assumed).
 *
 * Requires a real MCP bearer token (MCP_SMOKE_BEARER_TOKEN) — never
 * hardcoded, never printed. The MCP transport this script talks to may
 * respond over Server-Sent Events (see lessons-learned.md's "the live
 * gateway responds over SSE, not plain JSON" finding) — parseJsonRpcBody()
 * below handles both a plain JSON body and an `event: message\ndata: {...}`
 * SSE body, so this script doesn't silently fail against either transport
 * shape.
 *
 * Max-spend guard (Task 1): applied before step 5, even though step 5's
 * proof is deliberately invalid and should never reach a real settlement —
 * this is a defense-in-depth assertion, not a load-bearing gate, since the
 * settlement price for 't1_read' is fixed and small, but the guard is
 * applied on principle per the plan's Q&A (every live-touching script gets
 * it, no exceptions).
 *
 * Usage:
 *   MCP_SMOKE_BASE_URL=https://hypermove.duckdns.org/api/mcp \
 *   MCP_SMOKE_BEARER_TOKEN=<token> \
 *     npx tsx scripts/smoke-live-deployment.ts
 *
 * The optional paid-Dream mode requires MCP_SMOKE_XRPL_SEED for a funded
 * testnet wallet with RLUSD. It refuses mainnet and applies the spend guard
 * before signing; the seed and proof are never printed.
 */

import { randomUUID } from 'node:crypto';
import { assertWithinSpendGuard } from './lib/spend-guard';

const BASE_URL = process.env.MCP_SMOKE_BASE_URL ?? 'http://localhost:3003/api/mcp';
const BEARER_TOKEN = process.env.MCP_SMOKE_BEARER_TOKEN;
const HEALTH_URL = process.env.MCP_SMOKE_HEALTH_URL ?? BASE_URL.replace(/\/api\/mcp\/?$/, '/api/mcp/health');
const TEST_AGENT_ID = process.env.MCP_SMOKE_AGENT_ID ?? `smoke-test-${randomUUID().slice(0, 8)}`;
const RUN_PAID_DREAM = process.env.MCP_SMOKE_RUN_PAID_DREAM === 'true';

interface StepResult {
  step: number;
  name: string;
  pass: boolean;
  detail: string;
}

const results: StepResult[] = [];

function record(step: number, name: string, pass: boolean, detail: string): void {
  results.push({ step, name, pass, detail });
  console.log(`[${step}/5] ${pass ? 'PASS' : 'FAIL'} — ${name}: ${detail}`);
}

/**
 * Parses a JSON-RPC response body that may be either plain JSON (legacy
 * transport, gateway flag off) or an SSE envelope (`event: message\ndata:
 * {...}`, the real mcp-handler transport when the gateway is on). Never
 * assumes one shape and lets the other throw an opaque parse error.
 *
 * Exported for tests/smoke-live-deployment.test.ts's own unit coverage of
 * this parsing logic in isolation.
 */
export function parseJsonRpcBody(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }
  // SSE shape: one or more "event: ...\ndata: {...}\n\n" blocks — the
  // JSON-RPC payload is on the last `data:` line.
  const dataLines = trimmed.split('\n').filter((line) => line.startsWith('data:'));
  if (dataLines.length === 0) {
    throw new Error(`Could not parse response as JSON or SSE: ${raw.slice(0, 200)}`);
  }
  const lastData = dataLines[dataLines.length - 1].slice('data:'.length).trim();
  return JSON.parse(lastData) as Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>, id: number, extraHeaders?: HeadersInit): Promise<Record<string, unknown>> {
  if (!BEARER_TOKEN) {
    throw new Error('MCP_SMOKE_BEARER_TOKEN is required — get one via the documented no-wallet device-code flow (see docs/agent-auth) or /mcp-connect.');
  }
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${BEARER_TOKEN}`,
  });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const parsed = parseJsonRpcBody(raw);
  if (parsed.error) {
    // Structured JSON-RPC error — return it as-is so callers (e.g. step 5)
    // can distinguish "structured rejection" from "network-level ambiguous
    // error" (an unparseable body, a non-200 with no JSON-RPC envelope,
    // a connection failure, etc.).
    return { __jsonrpc_error: parsed.error };
  }
  return (parsed.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text
    ? (JSON.parse((parsed.result as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>)
    : (parsed.result as Record<string, unknown>) ?? {};
}

async function step1Health(): Promise<void> {
  try {
    const res = await fetch(HEALTH_URL);
    const body = (await res.json()) as { commit?: string | null; deployed_at?: string | null; real_payments_configured?: boolean; ok?: boolean };
    const pass = res.ok && body.ok === true;
    console.log(`      commit=${body.commit ?? 'null'} deployed_at=${body.deployed_at ?? 'null'} real_payments_configured=${body.real_payments_configured ?? 'unknown'}`);
    record(1, 'GET /api/mcp/health', pass, pass ? 'gateway reports ok=true' : `unexpected response: ${JSON.stringify(body)}`);
  } catch (err) {
    record(1, 'GET /api/mcp/health', false, `request failed: ${(err as Error).message}`);
  }
}

async function step2SubmitEpisodeLog(): Promise<void> {
  try {
    const result = await callTool('submit_episode_log', {
      agent_id: TEST_AGENT_ID,
      episodes: [{
        episode_id: randomUUID(),
        agent_id: TEST_AGENT_ID,
        timestamp: new Date().toISOString(),
        task_type: 'smoke-test',
        outcome: 'success',
        steps: [{ action: 'smoke-test-step' }],
      }],
    }, 2);
    const pass = typeof result.ingested_count === 'number' && (result.ingested_count as number) >= 1;
    record(2, 'submit_episode_log', pass, JSON.stringify(result));
  } catch (err) {
    record(2, 'submit_episode_log', false, `request failed: ${(err as Error).message}`);
  }
}

async function step3StartDream(): Promise<void> {
  try {
    const args = {
      agent_id: TEST_AGENT_ID,
      config: { budget_usd: 0.05, preset: 'balanced' },
    };
    const challenge = await callTool('start_dream', args, 3);
    const payment = challenge.payment as { quoteId?: string; merchant?: string; issuer?: string; nonce?: string; amount?: string; chain?: string } | undefined;
    if (!RUN_PAID_DREAM) {
      const pass = challenge.error === 'payment_required' && typeof payment?.quoteId === 'string';
      record(3, 'start_dream (unpaid -> quote challenge)', pass, JSON.stringify(challenge));
      return;
    }
    if (!payment?.quoteId || !payment.merchant || !payment.issuer || !payment.nonce || !payment.amount || payment.chain !== 'xrpl-testnet') {
      throw new Error('paid Dream mode requires a complete xrpl-testnet quote from start_dream');
    }
    const seed = process.env.MCP_SMOKE_XRPL_SEED;
    if (!seed) throw new Error('MCP_SMOKE_XRPL_SEED is required when MCP_SMOKE_RUN_PAID_DREAM=true');
    assertWithinSpendGuard(payment.amount);
    const { Client, Wallet } = await import('xrpl');
    const client = new Client('wss://s.altnet.rippletest.net:51233');
    const wallet = Wallet.fromSeed(seed);
    try {
      await client.connect();
      const tx = await client.submitAndWait({
        TransactionType: 'Payment', Account: wallet.classicAddress, Destination: payment.merchant,
        Amount: { currency: 'RLUSD', issuer: payment.issuer, value: payment.amount },
        Memos: [{ Memo: { MemoData: Buffer.from(payment.nonce).toString('hex') } }],
      }, { wallet });
      if ((tx.result.meta as { TransactionResult?: string } | undefined)?.TransactionResult !== 'tesSUCCESS') {
        throw new Error(`XRPL payment failed: ${(tx.result.meta as { TransactionResult?: string } | undefined)?.TransactionResult ?? 'unknown'}`);
      }
      const result = await callTool('start_dream', args, 4, {
        'x-payment-quote-id': payment.quoteId,
        'x-payment': JSON.stringify({ txHash: tx.result.hash }),
        'x-payment-chain': 'xrpl-testnet',
        'x-payment-asset': 'RLUSD',
      });
      const pass = typeof result.run_id === 'string' && typeof result.status === 'string';
      record(3, 'start_dream (fresh quote-bound payment)', pass, pass ? `run_id=${result.run_id}` : JSON.stringify(result));
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  } catch (err) {
    record(3, 'start_dream', false, `request failed: ${(err as Error).message}`);
  }
}

async function step4GetDreamStats(): Promise<void> {
  try {
    const result = await callTool('get_dream_stats', { agent_id: TEST_AGENT_ID }, 4);
    const stageSummaries = result.stage_summaries as { preprocessing?: { live_unconsumed_count?: unknown } } | undefined;
    const liveUnconsumedCount = stageSummaries?.preprocessing?.live_unconsumed_count;
    // Task 2 acceptance check: the new field must be present AND numeric —
    // this is the literal PRD 03 acceptance criterion ("prints the full
    // stage_summaries object"), tightened to actually assert on the new
    // field rather than only printing it.
    const pass = typeof liveUnconsumedCount === 'number';
    console.log(`      stage_summaries: ${JSON.stringify(result.stage_summaries ?? null)}`);
    record(4, 'get_dream_stats (live_unconsumed_count present)', pass, pass ? `live_unconsumed_count=${liveUnconsumedCount}` : 'stage_summaries.preprocessing.live_unconsumed_count missing or non-numeric');
  } catch (err) {
    record(4, 'get_dream_stats', false, `request failed: ${(err as Error).message}`);
  }
}

async function step5PaymentsSettleInvalidProof(): Promise<void> {
  try {
    // Defense-in-depth spend guard (Task 1) — applied on principle even
    // though this proof is deliberately malformed and should never reach a
    // real settlement. The fixed 't1_read' tier price is well under the
    // default $0.10 ceiling; this call exists to document the discipline,
    // not to gate a variable amount.
    assertWithinSpendGuard('0.01');

    const result = await callTool('payments.settle', {
      tier: 't1_read',
      chain: 'xrpl-testnet',
      proof: 'deliberately-invalid-proof-not-base64-not-json',
    }, 5);

    // A structured rejection means EITHER a JSON-RPC error object, OR a
    // well-formed {ok:false, ...} / {code: ...} result — NOT an unparsed/
    // ambiguous body (which callTool()/parseJsonRpcBody() would have
    // thrown on already, failing this step at the catch block below).
    const structuredRejection =
      '__jsonrpc_error' in result ||
      result.ok === false ||
      typeof result.code === 'string' ||
      typeof result.error === 'string';
    // Explicit assertion (per this script's own header comment) that this
    // deliberately-bad input never produces a real settlement success.
    const neverSettled = result.ok !== true;
    const pass = structuredRejection && neverSettled;
    record(5, 'payments.settle (invalid proof -> structured rejection)', pass, JSON.stringify(result));
  } catch (err) {
    // A thrown error here means the response was NOT parseable as
    // JSON/SSE at all — i.e. a genuinely ambiguous, non-structured failure,
    // which is exactly what this step is checking did NOT happen.
    record(5, 'payments.settle (invalid proof -> structured rejection)', false, `ambiguous/unparseable error, not a structured rejection: ${(err as Error).message}`);
  }
}

export async function main(): Promise<void> {
  console.log(`\nHyperMove live-deployment smoke test`);
  console.log(`  base_url=${BASE_URL}`);
  console.log(`  test_agent_id=${TEST_AGENT_ID}\n`);

  results.length = 0; // exported for test isolation across multiple main() calls in one process
  await step1Health();
  await step2SubmitEpisodeLog();
  await step3StartDream();
  await step4GetDreamStats();
  await step5PaymentsSettleInvalidProof();

  const passCount = results.filter((r) => r.pass).length;
  console.log(`\n${passCount}/5 steps passed.`);
  for (const r of results) {
    console.log(`  [${r.step}] ${r.pass ? '✓' : '✗'} ${r.name}`);
  }

  if (passCount < results.length) {
    process.exitCode = 1;
  }
}

export function getResults(): StepResult[] {
  return results;
}

// Only auto-run when executed directly (npx tsx scripts/smoke-live-deployment.ts),
// never when imported by a test (tests/smoke-live-deployment.test.ts) — mirrors
// the standard Node "is this the entry module" guard so importing this file for
// its exported functions never triggers a real network call as a side effect.
if (require.main === module) {
  main().catch((err) => {
    console.error('\n✗ Smoke test crashed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
