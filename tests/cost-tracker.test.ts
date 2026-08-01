/**
 * tests/cost-tracker.test.ts
 * ---------------------------
 * Standalone test for the relocated CostTracker (src/lib/cost/tracker.ts,
 * Task 4 of the v2.1 guardrails/cost-accounting plan). Imports directly from
 * the new path (not via the dream/cost.ts re-export) to prove it is usable
 * with zero Dream Cycle dependency.
 */

import { describe, it, expect } from 'vitest';
import { CostTracker, estimateTokens } from '@/lib/cost/tracker';

describe('CostTracker (standalone, no Dream Cycle dependency)', () => {
  it('estimates cost from the default price table', () => {
    const tracker = new CostTracker(1);
    const cost = tracker.estimateCostUsd(1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.25 + 1.25, 5);
  });

  it('canAfford respects the remaining budget before recording', () => {
    const tracker = new CostTracker(0.001);
    expect(tracker.canAfford(0.0005)).toBe(true);
    expect(tracker.canAfford(0.01)).toBe(false);
  });

  it('record() accumulates spend and per-stage token counts', () => {
    const tracker = new CostTracker(1);
    tracker.record('extraction', 1000, 500);
    tracker.record('extraction', 200, 100);
    expect(tracker.perStageTokenCounts.extraction).toBe(1800);
    expect(tracker.budgetUsedUsd).toBeGreaterThan(0);
    expect(tracker.remainingUsd).toBeLessThan(1);
  });

  it('estimateTokens is a cheap deterministic chars/4 estimate', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('')).toBe(0);
  });
});
