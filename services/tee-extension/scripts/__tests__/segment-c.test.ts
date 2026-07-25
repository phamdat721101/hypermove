/**
 * segment-c.test.ts — T5-6: unit test the message-decode step in isolation with a
 * fixture payload (no network calls). The real XRPL-testnet-reachability integration
 * test is intentionally NOT included here — it requires real network access and a
 * funded XRPL_SEED, and is documented as a manual/CI-gated run in the PRD, matching
 * this codebase's existing convention for live-network tests (skipped when the
 * required env var is absent, per hypermove-app's own test conventions).
 */
import { describe, it, expect } from 'vitest';
import { decodeFinancialActionEvidence } from '../segment-c.js';

describe('decodeFinancialActionEvidence', () => {
  it('extracts action/amount/chain from a well-formed evidence fixture', () => {
    const decoded = decodeFinancialActionEvidence({
      action: 'SWAP',
      amount: '1',
      chain: 'xrpl',
    });
    expect(decoded).toEqual({ action: 'SWAP', amount: '1', chain: 'xrpl' });
  });

  it('returns an empty object when evidence is undefined', () => {
    expect(decodeFinancialActionEvidence(undefined)).toEqual({
      action: undefined,
      amount: undefined,
      chain: undefined,
    });
  });

  it('ignores non-string field values rather than throwing', () => {
    const decoded = decodeFinancialActionEvidence({
      action: 'SWAP',
      amount: 42 as unknown as string, // malformed on purpose — simulates a bad upstream shape
      chain: 'xrpl',
    });
    expect(decoded.amount).toBeUndefined();
    expect(decoded.action).toBe('SWAP');
    expect(decoded.chain).toBe('xrpl');
  });
});
