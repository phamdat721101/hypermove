/**
 * tests/spend-guard.test.ts
 * ---------------------------
 * Unit tests for scripts/lib/spend-guard.ts — the max-spend safety guard
 * added for the 2026-08-11 Dream Cycle/FCC/RLUSD status-review upgrade
 * (Task 1). Pure-function module, zero network, zero DB — mirrors this
 * repo's fastest-tier test style (see cost-tracker.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertWithinSpendGuard, resolveMaxLiveSpendUsd, SpendGuardExceededError } from '../scripts/lib/spend-guard';

describe('spend-guard', () => {
  const savedEnv = process.env.MAX_LIVE_SPEND_USD;

  beforeEach(() => {
    delete process.env.MAX_LIVE_SPEND_USD;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MAX_LIVE_SPEND_USD;
    else process.env.MAX_LIVE_SPEND_USD = savedEnv;
  });

  describe('resolveMaxLiveSpendUsd', () => {
    it('defaults to $0.10 when MAX_LIVE_SPEND_USD is unset', () => {
      expect(resolveMaxLiveSpendUsd()).toBe(0.1);
    });

    it('respects an explicit MAX_LIVE_SPEND_USD override', () => {
      process.env.MAX_LIVE_SPEND_USD = '0.25';
      expect(resolveMaxLiveSpendUsd()).toBe(0.25);
    });

    it('throws on a non-numeric MAX_LIVE_SPEND_USD', () => {
      process.env.MAX_LIVE_SPEND_USD = 'not-a-number';
      expect(() => resolveMaxLiveSpendUsd()).toThrow(/not a valid non-negative number/);
    });

    it('throws on a negative MAX_LIVE_SPEND_USD', () => {
      process.env.MAX_LIVE_SPEND_USD = '-1';
      expect(() => resolveMaxLiveSpendUsd()).toThrow(/not a valid non-negative number/);
    });
  });

  describe('assertWithinSpendGuard', () => {
    it('passes for an amount at the default ceiling ($0.10)', () => {
      expect(() => assertWithinSpendGuard('0.10')).not.toThrow();
    });

    it('passes for an amount under the default ceiling', () => {
      expect(() => assertWithinSpendGuard('0.05')).not.toThrow();
      expect(() => assertWithinSpendGuard(0.05)).not.toThrow();
    });

    it('throws SpendGuardExceededError for an amount above the default ceiling', () => {
      expect(() => assertWithinSpendGuard('0.11')).toThrow(SpendGuardExceededError);
      expect(() => assertWithinSpendGuard('5.00')).toThrow(/Refusing to submit a live payment/);
    });

    it('rejects an artificially-inflated amount even if formatted as a plain decimal string', () => {
      expect(() => assertWithinSpendGuard('100')).toThrow(SpendGuardExceededError);
    });

    it('respects an explicit maxUsd override passed directly (bypassing env)', () => {
      expect(() => assertWithinSpendGuard('0.50', { maxUsd: 1 })).not.toThrow();
      expect(() => assertWithinSpendGuard('0.50', { maxUsd: 0.1 })).toThrow(SpendGuardExceededError);
    });

    it('respects a raised MAX_LIVE_SPEND_USD env override', () => {
      process.env.MAX_LIVE_SPEND_USD = '1.00';
      expect(() => assertWithinSpendGuard('0.50')).not.toThrow();
    });

    it('throws a plain Error (not SpendGuardExceededError) for a malformed amount', () => {
      expect(() => assertWithinSpendGuard('not-a-number')).toThrow(/not a valid non-negative number/);
      expect(() => assertWithinSpendGuard('-0.01')).toThrow(/not a valid non-negative number/);
    });

    it('error message names both the offending amount and the configured ceiling', () => {
      try {
        assertWithinSpendGuard('0.50');
        throw new Error('expected assertWithinSpendGuard to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SpendGuardExceededError);
        const guardErr = err as SpendGuardExceededError;
        expect(guardErr.amountUsd).toBe(0.5);
        expect(guardErr.maxUsd).toBe(0.1);
        expect(guardErr.message).toContain('$0.5');
        expect(guardErr.message).toContain('$0.1');
      }
    });
  });
});
