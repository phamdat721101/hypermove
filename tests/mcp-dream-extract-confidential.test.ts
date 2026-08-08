/**
 * tests/mcp-dream-extract-confidential.test.ts — Dream Cycle Confidential
 * Extraction on Flare FCC, Task 4.
 *
 * Deterministic + offline: mocks buildRouter()'s flareConfidentialStatus
 * liveness check and flare-instruct.ts's dispatchInstruction() directly, so
 * no live RPC/network call happens. Mirrors tests/mcp-flare.test.ts's own
 * "honest corpus-only reads (no fabrication)" discipline, applied to the
 * Dream Cycle extraction boundary instead of a raw provider read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EpisodeCluster } from '../src/lib/mcp/dream/cluster';
import { CostTracker } from '../src/lib/mcp/dream/cost';

function makeCluster(id: string): EpisodeCluster {
  return {
    cluster_id: id,
    agent_id: 'robot-42',
    episode_ids: [`${id}-ep-1`],
    size: 1,
    time_range: {},
    dominant_tags: [],
    centroid_embedding: [0.1, 0.2],
    summary: 'failure:navigate:move,turn',
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('Task 4 · extractInsights(confidential=true) — FCC not live (real current state)', () => {
  it('routes every cluster through the confidential backend and reports fcc_not_live with ZERO extraction cost', async () => {
    vi.doMock('../src/lib/mcp/providers', () => ({
      buildRouter: () => ({
        dispatch: vi.fn(async () => ({ ok: false, error: { service: 'router', message: 'not live', kind: 'soft-empty' } })),
      }),
    }));
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const cost = new CostTracker(0.10);
    const clusters = [makeCluster('c1'), makeCluster('c2')];

    const outcome = await extractInsights(clusters, cost, 100, true);

    expect(outcome.status).toBe('partial');
    expect(outcome.clusters_failed_extraction).toEqual(['c1', 'c2']);
    expect(outcome.extracted).toHaveLength(0);
    expect(cost.budgetUsedUsd).toBe(0); // never charge for a non-genuine confidential attempt
  });

  it('never calls dispatchInstruction at all when the liveness check itself fails (fail-closed, no wasted dispatch)', async () => {
    const dispatchSpy = vi.fn();
    vi.doMock('../src/lib/mcp/providers', () => ({
      buildRouter: () => ({ dispatch: vi.fn(async () => ({ ok: false, error: { service: 'router', message: 'not live', kind: 'soft-empty' } })) }),
    }));
    vi.doMock('../src/lib/mcp/flare-instruct', () => ({ dispatchInstruction: dispatchSpy }));
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const cost = new CostTracker(0.10);
    await extractInsights([makeCluster('c1')], cost, 100, true);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('confidential=false (default, omitted) keeps using the plaintext extractOneCluster path — byte-identical to pre-Task-4 behavior', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ rules: ['r1'], preferences: [], error_patterns: [], facts: [] }) }));
    vi.doMock('../src/lib/mcp/http', () => ({ fetchWithTimeout: fetchSpy }));
    const routerDispatch = vi.fn();
    vi.doMock('../src/lib/mcp/providers', () => ({ buildRouter: () => ({ dispatch: routerDispatch }) }));
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const cost = new CostTracker(0.10);
    const outcome = await extractInsights([makeCluster('c1')], cost, 100);
    expect(outcome.extracted).toHaveLength(1);
    expect(outcome.extracted[0].rules).toEqual(['r1']);
    expect(routerDispatch).not.toHaveBeenCalled(); // plaintext path never touches the Flare router
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Task 4 · extractInsights(confidential=true) — dispatch reachable but the TEE extension refuses (real honest-stub state)', () => {
  it('when FCC reports live but dispatchInstruction fails (e.g. not_configured), reports fcc_not_configured with zero cost', async () => {
    vi.doMock('../src/lib/mcp/providers', () => ({
      buildRouter: () => ({ dispatch: vi.fn(async () => ({ ok: true, data: { live: true } })) }),
    }));
    vi.doMock('../src/lib/mcp/flare-instruct', () => ({
      dispatchInstruction: vi.fn(async () => ({ ok: false, error: { service: 'flare-instruct', message: 'TEE-extension service not configured', code: 'not_configured' } })),
    }));
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const cost = new CostTracker(0.10);
    const outcome = await extractInsights([makeCluster('c1')], cost, 100, true);
    expect(outcome.clusters_failed_extraction).toEqual(['c1']);
    expect(cost.budgetUsedUsd).toBe(0);
  });

  it('when dispatch succeeds but the extension has not yet been taught to return genuine insights, never fabricates a genuine result', async () => {
    // Matches services/tee-extension's documented "honest-stub boundary" —
    // processGenericAgentTask always refuses today. Task 5 (attestation
    // binding) is what will eventually let a genuine result flow through;
    // until then this branch must stay non-genuine even on a 2xx dispatch.
    vi.doMock('../src/lib/mcp/providers', () => ({
      buildRouter: () => ({ dispatch: vi.fn(async () => ({ ok: true, data: { live: true } })) }),
    }));
    vi.doMock('../src/lib/mcp/flare-instruct', () => ({
      dispatchInstruction: vi.fn(async () => ({ ok: true, data: { instructionId: '0xabc', txHash: '0xabc', status: 'success', settlementTxHash: null, data: { refused: true } } })),
    }));
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const cost = new CostTracker(0.10);
    const outcome = await extractInsights([makeCluster('c1')], cost, 100, true);
    expect(outcome.extracted).toHaveLength(0);
    expect(outcome.clusters_failed_extraction).toEqual(['c1']);
    expect(cost.budgetUsedUsd).toBe(0);
  });
});

describe('Task 5 · attestation binding — the forward-looking "FCC now live + extension returns real data" path', () => {
  it('accepts a genuine dispatch whose attestation quote verifies, charges cost, and surfaces the attestation_ref', async () => {
    vi.doMock('../src/lib/mcp/providers', () => ({
      buildRouter: () => ({ dispatch: vi.fn(async () => ({ ok: true, data: { live: true } })) }),
    }));
    vi.doMock('../src/lib/mcp/flare-instruct', () => ({
      dispatchInstruction: vi.fn(async () => ({
        ok: true,
        data: {
          instructionId: '0xabc', txHash: '0xabc', status: 'success', settlementTxHash: null,
          data: { attestationQuote: '0xdeadbeef', insights: { rules: ['always retry on timeout'], preferences: [], error_patterns: [], facts: [] } },
        },
      })),
    }));
    vi.doMock('../src/lib/mcp/confidential', () => ({
      verifyAttestation: vi.fn(async () => ({ ok: true, data: { attested: true, provider: 'phala-cloud', quoteHash: 'deadbeef12345678', verifiedAt: new Date().toISOString(), codeIdentity: 'mrtd-abc' } })),
    }));
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const cost = new CostTracker(0.10);
    const outcome = await extractInsights([makeCluster('c1')], cost, 100, true);
    expect(outcome.extracted).toHaveLength(1);
    expect(outcome.extracted[0].rules).toEqual(['always retry on timeout']);
    expect(outcome.attestation_refs).toEqual(['deadbeef12345678']);
    expect(outcome.clusters_failed_extraction).toHaveLength(0);
    expect(cost.budgetUsedUsd).toBeGreaterThan(0); // genuine output IS cost-worthy
  });

  it('rejects a genuine-looking dispatch whose attestation FAILS verification — never silently trusted', async () => {
    vi.doMock('../src/lib/mcp/providers', () => ({
      buildRouter: () => ({ dispatch: vi.fn(async () => ({ ok: true, data: { live: true } })) }),
    }));
    vi.doMock('../src/lib/mcp/flare-instruct', () => ({
      dispatchInstruction: vi.fn(async () => ({
        ok: true,
        data: {
          instructionId: '0xabc', txHash: '0xabc', status: 'success', settlementTxHash: null,
          data: { attestationQuote: '0xbadquote', insights: { rules: ['fabricated rule'], preferences: [], error_patterns: [], facts: [] } },
        },
      })),
    }));
    vi.doMock('../src/lib/mcp/confidential', () => ({
      verifyAttestation: vi.fn(async () => ({ ok: false, error: { service: 'confidential', message: 'attestation quote failed verification', kind: 'error', code: 'attestation_invalid' } })),
    }));
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const cost = new CostTracker(0.10);
    const outcome = await extractInsights([makeCluster('c1')], cost, 100, true);
    expect(outcome.extracted).toHaveLength(0); // the "fabricated rule" never enters extracted
    expect(outcome.clusters_failed_extraction).toEqual(['c1']);
    expect(outcome.attestation_refs).toHaveLength(0);
    expect(cost.budgetUsedUsd).toBe(0); // never charge for an untrusted result
  });

  it('a genuine dispatch missing attestationQuote entirely (today\'s real honest-stub state) never reaches the attestation check', async () => {
    const verifySpy = vi.fn();
    vi.doMock('../src/lib/mcp/providers', () => ({
      buildRouter: () => ({ dispatch: vi.fn(async () => ({ ok: true, data: { live: true } })) }),
    }));
    vi.doMock('../src/lib/mcp/flare-instruct', () => ({
      dispatchInstruction: vi.fn(async () => ({ ok: true, data: { instructionId: '0xabc', txHash: '0xabc', status: 'success', settlementTxHash: null, data: { refused: true } } })),
    }));
    vi.doMock('../src/lib/mcp/confidential', () => ({ verifyAttestation: verifySpy }));
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const cost = new CostTracker(0.10);
    await extractInsights([makeCluster('c1')], cost, 100, true);
    expect(verifySpy).not.toHaveBeenCalled();
  });
});
