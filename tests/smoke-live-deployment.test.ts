/**
 * tests/smoke-live-deployment.test.ts
 * ---------------------------------------
 * Coverage for scripts/smoke-live-deployment.ts (2026-08-11 status-review
 * upgrade, Task 6 / PRD 03). Mocks the MCP HTTP layer entirely (global
 * fetch) so this test verifies step sequencing + pass/fail reporting logic
 * WITHOUT touching a real network — matches this repo's own stated
 * convention (tests/mcp-xrpl-settlement.test.ts's header comment: mocked
 * tier always runs, live tier is opt-in via an explicit env var and never
 * auto-run).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function sseEnvelope(result: unknown): string {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`;
}

beforeEach(() => {
  process.env.MCP_SMOKE_BASE_URL = 'https://smoke-test.invalid/api/mcp';
  process.env.MCP_SMOKE_HEALTH_URL = 'https://smoke-test.invalid/api/mcp/health';
  process.env.MCP_SMOKE_BEARER_TOKEN = 'test-bearer-token';
  process.env.MCP_SMOKE_AGENT_ID = 'smoke-test-fixed-agent';
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('Task 6 (2026-08-11 status-review upgrade) · smoke-live-deployment.ts', () => {
  it('parseJsonRpcBody handles a plain JSON body', async () => {
    const { parseJsonRpcBody } = await import('../scripts/smoke-live-deployment');
    const parsed = parseJsonRpcBody(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    expect(parsed.result).toEqual({ ok: true });
  });

  it('parseJsonRpcBody handles an SSE envelope (event: message\\ndata: {...})', async () => {
    const { parseJsonRpcBody } = await import('../scripts/smoke-live-deployment');
    const parsed = parseJsonRpcBody(sseEnvelope({ ok: true, from: 'sse' }));
    expect(parsed.result).toEqual({ ok: true, from: 'sse' });
  });

  it('parseJsonRpcBody throws a clear error for an unparseable body (neither JSON nor SSE)', async () => {
    const { parseJsonRpcBody } = await import('../scripts/smoke-live-deployment');
    expect(() => parseJsonRpcBody('not json, not sse, just garbage')).toThrow(/Could not parse response/);
  });

  it('runs all 5 steps in order and reports 5/5 pass when every call succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/health')) {
        return new Response(JSON.stringify({ ok: true, commit: 'abc123', deployed_at: '2026-08-11T00:00:00Z', real_payments_configured: true }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { id: number; params: { name: string } };
      const name = body.params.name;
      if (name === 'submit_episode_log') return new Response(sseEnvelope({ ingested_count: 1, rejected: [] }), { status: 200 });
      if (name === 'start_dream') return new Response(sseEnvelope({ run_id: 'run-1', status: 'started' }), { status: 200 });
      if (name === 'get_dream_stats') return new Response(sseEnvelope({ stage_summaries: { preprocessing: { live_unconsumed_count: 0 } } }), { status: 200 });
      if (name === 'payments.settle') return new Response(sseEnvelope({ ok: false, error: 'invalid_proof' }), { status: 200 });
      throw new Error(`unexpected tool call in test: ${name}`);
    }));

    const mod = await import('../scripts/smoke-live-deployment');
    await mod.main();
    const results = mod.getResults();

    expect(results).toHaveLength(5);
    expect(results.map((r) => r.step)).toEqual([1, 2, 3, 4, 5]);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it('step 4 fails when live_unconsumed_count is missing from get_dream_stats response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { params: { name: string } };
      const name = body.params.name;
      if (name === 'submit_episode_log') return new Response(sseEnvelope({ ingested_count: 1 }), { status: 200 });
      if (name === 'start_dream') return new Response(sseEnvelope({ run_id: 'run-1', status: 'started' }), { status: 200 });
      // Deliberately missing stage_summaries entirely.
      if (name === 'get_dream_stats') return new Response(sseEnvelope({}), { status: 200 });
      if (name === 'payments.settle') return new Response(sseEnvelope({ ok: false }), { status: 200 });
      throw new Error(`unexpected tool call: ${name}`);
    }));

    const mod = await import('../scripts/smoke-live-deployment');
    await mod.main();
    const results = mod.getResults();

    const step4 = results.find((r) => r.step === 4);
    expect(step4?.pass).toBe(false);
    expect(step4?.detail).toMatch(/missing or non-numeric/);
  });

  it('step 5 PASSES for a structured rejection ({ok:false}) and never treats it as a real settlement', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { params: { name: string } };
      const name = body.params.name;
      if (name === 'submit_episode_log') return new Response(sseEnvelope({ ingested_count: 1 }), { status: 200 });
      if (name === 'start_dream') return new Response(sseEnvelope({ run_id: 'run-1', status: 'started' }), { status: 200 });
      if (name === 'get_dream_stats') return new Response(sseEnvelope({ stage_summaries: { preprocessing: { live_unconsumed_count: 0 } } }), { status: 200 });
      if (name === 'payments.settle') return new Response(sseEnvelope({ ok: false, code: 'invalid_proof_shape' }), { status: 200 });
      throw new Error(`unexpected tool call: ${name}`);
    }));

    const mod = await import('../scripts/smoke-live-deployment');
    await mod.main();
    const step5 = mod.getResults().find((r) => r.step === 5);
    expect(step5?.pass).toBe(true);
  });

  it('step 5 FAILS if payments.settle somehow reports a real success (ok: true) for a deliberately invalid proof', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { params: { name: string } };
      const name = body.params.name;
      if (name === 'submit_episode_log') return new Response(sseEnvelope({ ingested_count: 1 }), { status: 200 });
      if (name === 'start_dream') return new Response(sseEnvelope({ run_id: 'run-1', status: 'started' }), { status: 200 });
      if (name === 'get_dream_stats') return new Response(sseEnvelope({ stage_summaries: { preprocessing: { live_unconsumed_count: 0 } } }), { status: 200 });
      // A malformed proof should NEVER produce ok:true — if it somehow did,
      // this step must fail loudly rather than report a false pass.
      if (name === 'payments.settle') return new Response(sseEnvelope({ ok: true }), { status: 200 });
      throw new Error(`unexpected tool call: ${name}`);
    }));

    const mod = await import('../scripts/smoke-live-deployment');
    await mod.main();
    const step5 = mod.getResults().find((r) => r.step === 5);
    expect(step5?.pass).toBe(false);
  });

  it('step 5 FAILS (not silently passes) on a genuinely ambiguous/unparseable network-level error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { params: { name: string } };
      const name = body.params.name;
      if (name === 'submit_episode_log') return new Response(sseEnvelope({ ingested_count: 1 }), { status: 200 });
      if (name === 'start_dream') return new Response(sseEnvelope({ run_id: 'run-1', status: 'started' }), { status: 200 });
      if (name === 'get_dream_stats') return new Response(sseEnvelope({ stage_summaries: { preprocessing: { live_unconsumed_count: 0 } } }), { status: 200 });
      if (name === 'payments.settle') return new Response('<html>502 Bad Gateway</html>', { status: 502 });
      throw new Error(`unexpected tool call: ${name}`);
    }));

    const mod = await import('../scripts/smoke-live-deployment');
    await mod.main();
    const step5 = mod.getResults().find((r) => r.step === 5);
    expect(step5?.pass).toBe(false);
    expect(step5?.detail).toMatch(/ambiguous\/unparseable/);
  });

  it('throws a clear error when MCP_SMOKE_BEARER_TOKEN is unset, without ever attempting a network call for that step', async () => {
    delete process.env.MCP_SMOKE_BEARER_TOKEN;
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error('should not reach tools/call without a bearer token');
    }));

    const mod = await import('../scripts/smoke-live-deployment');
    await mod.main();
    const step2 = mod.getResults().find((r) => r.step === 2);
    expect(step2?.pass).toBe(false);
    expect(step2?.detail).toMatch(/MCP_SMOKE_BEARER_TOKEN is required/);
  });
});
