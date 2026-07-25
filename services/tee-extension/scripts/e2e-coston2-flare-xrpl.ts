#!/usr/bin/env node
/**
 * e2e-coston2-flare-xrpl.ts
 * -------------------------
 * Orchestrator for HyperMove's Flare TEE-proxy E2E script. See the PRD at
 * biz-team/bd-team/research/hypermove/2026-07-23-tee-proxy-e2e-script-coston2/.
 *
 * Segment A (Coston2, real):      deploy + register HyperMoveInstructionSender,
 *                                  stop honestly at the T1 (indexer-DB) blocker.
 * Segment B (local, simulated):   full contract -> ext-proxy -> extension-tee ->
 *                                  result loop against SIMULATED_TEE=true.
 * Segment C (XRPL testnet, real): real RLUSD settlement via n-payment, driven by
 *                                  the exact message sent on-chain in Segment B.
 *
 * Run: npm run e2e:tee-flare-xrpl
 *
 * SECURITY: this script never logs, writes, or persists a secret env var VALUE —
 * only whether each required key is present. Supply DEPLOYMENT_PRIVATE_KEY via a
 * local, gitignored .env.coston2 file in this directory. Never paste it in chat.
 */
import { loadConfig, describeMissingConfig } from './config.js';
import { runAggregateReport, formatReportHuman } from './report.js';
import { runSegmentA } from './segment-a.js';
import { runSegmentB } from './segment-b.js';
import { runSegmentC } from './segment-c.js';
import type { SegmentResult } from './types.js';

async function main(): Promise<number> {
  const check = loadConfig();

  if (!check.ok) {
    // T1-6: no env vars set -> NEEDS_CONTEXT, no network/chain calls, exit non-zero.
    console.log('STATUS: NEEDS_CONTEXT');
    console.log(describeMissingConfig(check));
    console.log(
      'Fields checked (presence only, no values ever printed):',
      check.fields.map((f) => `${f.key}=${f.present ? 'present' : 'missing'}`).join(', '),
    );
    return 1;
  }

  const allResults: SegmentResult[] = [];

  // --- Segment A: Coston2 deploy + registration, honest stop at T1 ---
  const segmentAResults = await runSegmentA(check.config);
  allResults.push(...segmentAResults);

  // --- Segment B: local simulated full loop (contract -> ext-proxy -> extension-tee) ---
  const segmentBResults = await runSegmentB(check.config);
  allResults.push(...segmentBResults);

  // --- Segment C: real RLUSD settlement on XRPL testnet, driven by Segment B's message ---
  const financialActionMessage = segmentBResults.find(
    (r) => r.step === 'submit-financial-action',
  )?.evidence?.extra;
  const segmentCResults = await runSegmentC(check.config, financialActionMessage);
  allResults.push(...segmentCResults);

  const report = await runAggregateReport(allResults);

  console.log(formatReportHuman(report));
  console.log('');
  console.log(JSON.stringify(report, null, 2));

  return report.ranToCompletion ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('FATAL — orchestrator crashed before producing a report:');
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
