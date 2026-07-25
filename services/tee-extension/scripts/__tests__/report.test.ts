/**
 * report.test.ts — T1-5: unit test the aggregation/formatting function against
 * fixture SegmentResult[] inputs. No network calls.
 */
import { describe, it, expect } from 'vitest';
import { aggregateReport, formatReportHuman, runAggregateReport } from '../report.js';
import type { SegmentResult } from '../types.js';

const realSegmentA: SegmentResult = {
  segment: 'A',
  step: 'deploy',
  status: 'real',
  evidence: { txHash: '0xabc123', address: '0xdeadbeef' },
  message: 'Deployed HyperMoveInstructionSender on Coston2.',
};

const blockedSegmentA: SegmentResult = {
  segment: 'A',
  step: 'start-ext-proxy',
  status: 'blocked',
  blockerId: 'T1',
  message: 'ext-proxy cannot start without Flare indexer-DB credentials. Contact Flare support / @FlareDevs.',
};

const simulatedSegmentB: SegmentResult = {
  segment: 'B',
  step: 'boot-local-stack',
  status: 'simulated',
  evidence: { extra: { platform: 'SIMULATED_TEE' } },
  message: 'Local Hardhat devnet + ext-proxy + extension-tee booted with SIMULATED_TEE=true.',
};

const realSegmentC: SegmentResult = {
  segment: 'C',
  step: 'xrpl-payment',
  status: 'real',
  evidence: { txHash: 'ABCDEF1234567890' },
  message: 'Real RLUSD payment submitted on XRPL testnet.',
};

const errorResult: SegmentResult = {
  segment: 'B',
  step: 'poll-result',
  status: 'error',
  message: 'Timed out polling ext-proxy for GENERIC_AGENT_TASK result.',
};

describe('aggregateReport', () => {
  it('marks ranToCompletion true when every segment reaches an expected terminal state (including blocked)', () => {
    const report = aggregateReport([realSegmentA, blockedSegmentA, simulatedSegmentB, realSegmentC]);
    expect(report.ranToCompletion).toBe(true);
    expect(report.results).toHaveLength(4);
    expect(report.generatedAt).toBeTruthy();
  });

  it('marks ranToCompletion false when any segment result is an unresolved error', () => {
    const report = aggregateReport([realSegmentA, errorResult]);
    expect(report.ranToCompletion).toBe(false);
  });

  it('treats an expected blocked result as completion, not failure', () => {
    const report = aggregateReport([blockedSegmentA]);
    expect(report.ranToCompletion).toBe(true);
  });
});

describe('formatReportHuman', () => {
  it('renders one line per segment result with status label and context', () => {
    const report = aggregateReport([realSegmentA, blockedSegmentA]);
    const text = formatReportHuman(report);
    expect(text).toContain('REAL (coston2)');
    expect(text).toContain('BLOCKED (coston2) [T1]');
    expect(text).toContain('0xabc123');
  });

  it('includes evidence fields (tx, address, url) when present', () => {
    const report = aggregateReport([realSegmentC]);
    const text = formatReportHuman(report);
    expect(text).toContain('tx: ABCDEF1234567890');
  });
});

describe('runAggregateReport (harnessed)', () => {
  it('returns a well-formed FinalReport for valid fixture input', async () => {
    const report = await runAggregateReport([realSegmentA, blockedSegmentA]);
    expect(report.ranToCompletion).toBe(true);
    expect(report.results).toHaveLength(2);
  });

  it('produces an empty-but-well-formed report for an empty result set (vacuous completion)', async () => {
    const report = await runAggregateReport([]);
    expect(report.results).toHaveLength(0);
    expect(report.ranToCompletion).toBe(true);
  });
});
