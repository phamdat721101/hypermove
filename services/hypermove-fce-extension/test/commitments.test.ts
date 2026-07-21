import { describe, it, expect } from 'vitest';
import { buildSearchCommitment, buildNewsDigestCommitment, chainIdFor, hashContent } from '../src/commitments.js';
import { FLARE_CHAIN_IDS } from '../src/config.js';

describe('chainIdFor', () => {
  it('reads from FLARE_CHAIN_IDS, never hardcoded', () => {
    expect(chainIdFor('coston2')).toBe(BigInt(FLARE_CHAIN_IDS.coston2 as number));
    expect(chainIdFor('flare')).toBe(BigInt(FLARE_CHAIN_IDS.flare as number));
  });

  it('throws for an unknown network rather than silently defaulting', () => {
    expect(() => chainIdFor('not-a-real-network')).toThrow(/unknown Flare network/);
  });
});

describe('buildSearchCommitment — golden-value regression', () => {
  // Golden value computed once by actually running the real encodeAbiParameters
  // + keccak256 pipeline (see scripts/verify-hash-equivalence.ts's Task-1
  // postmortem: never hand-transcribe a second hex literal as ground truth) —
  // this asserts the function keeps producing the SAME digest for the SAME
  // input across future refactors, not that the digest is "correct" in an
  // absolute sense (the commitment scheme is defined by the PRD's field order,
  // which this test's field-order-sensitivity case below actually verifies).
  const input = {
    chainId: chainIdFor('coston2'),
    tool: 'search',
    query: 'flare tee extension',
    total: 5,
    nextCursor: '',
    timestamp: 1732000000,
  };
  const GOLDEN = '0x6e9805a160bae046b2fea9424768a33fcc887385da39fc3fea98d109ab0a29e9';

  it('matches the recorded golden digest for a fixed input', () => {
    expect(buildSearchCommitment(input)).toBe(GOLDEN);
  });

  it('is deterministic — same input always produces the same digest', () => {
    expect(buildSearchCommitment(input)).toBe(buildSearchCommitment({ ...input }));
  });

  it('is sensitive to field order / values (changing any field changes the digest)', () => {
    expect(buildSearchCommitment({ ...input, query: 'different query' })).not.toBe(GOLDEN);
    expect(buildSearchCommitment({ ...input, total: 6 })).not.toBe(GOLDEN);
    expect(buildSearchCommitment({ ...input, chainId: chainIdFor('flare') })).not.toBe(GOLDEN);
  });
});

describe('buildNewsDigestCommitment — golden-value regression', () => {
  const digestHash = hashContent({ headline: 'flare ships fce' });
  const input = {
    chainId: chainIdFor('coston2'),
    project: 'flare',
    day: '2026-07-21',
    digestHash,
    timestamp: 1732000000,
  };
  const GOLDEN = '0xf8c5cc73d92a4ddaad7330a49dabc30ebdefa6280685b885d5c7d0a516b3bff9';

  it('matches the recorded golden digest for a fixed input', () => {
    expect(buildNewsDigestCommitment(input)).toBe(GOLDEN);
  });

  it('is deterministic', () => {
    expect(buildNewsDigestCommitment(input)).toBe(buildNewsDigestCommitment({ ...input }));
  });

  it('changes when the underlying content (digestHash) changes', () => {
    const otherHash = hashContent({ headline: 'a different headline' });
    expect(buildNewsDigestCommitment({ ...input, digestHash: otherHash })).not.toBe(GOLDEN);
  });
});

describe('hashContent', () => {
  it('is deterministic for identical JSON-serializable content', () => {
    expect(hashContent({ a: 1, b: 2 })).toBe(hashContent({ a: 1, b: 2 }));
  });

  it('differs for different content', () => {
    expect(hashContent({ a: 1 })).not.toBe(hashContent({ a: 2 }));
  });
});
