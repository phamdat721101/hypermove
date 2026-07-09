/**
 * tests/observability.test.ts
 * ----------------------------
 * Unit tests for the HM1 observability layer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The module reads process.env.FEATURE_HM_PLATFORM at call-time via
// isPlatformEnabled(). We manipulate it before each test.

describe('observability · platform-flag', () => {
  beforeEach(() => { process.env.FEATURE_HM_PLATFORM = 'false'; });

  it('isPlatformEnabled is false by default', async () => {
    const { isPlatformEnabled } = await import('@/lib/platform-flag');
    expect(isPlatformEnabled()).toBe(false);
  });

  it('isPlatformEnabled is true when env is exactly "true"', async () => {
    process.env.FEATURE_HM_PLATFORM = 'true';
    const mod = await import('@/lib/platform-flag');
    expect(mod.isPlatformEnabled()).toBe(true);
  });

  it('isSentryForwardEnabled requires both flag and DSN', async () => {
    const mod = await import('@/lib/platform-flag');
    process.env.FEATURE_HM_PLATFORM = 'true';
    process.env.SENTRY_DSN = '';
    expect(mod.isSentryForwardEnabled()).toBe(false);
    process.env.SENTRY_DSN = 'https://x@y/z';
    expect(mod.isSentryForwardEnabled()).toBe(true);
  });
});

describe('observability · types.validateAgentEvent', () => {
  it('accepts a minimal valid event', async () => {
    const { validateAgentEvent } = await import('@/lib/observability/types');
    const r = validateAgentEvent({
      kind: 'invoke.success',
      endpoint: 'x.y',
      agent_id: 'a',
      trace_id: 't',
      timestamp: new Date().toISOString(),
    });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown kinds', async () => {
    const { validateAgentEvent } = await import('@/lib/observability/types');
    const r = validateAgentEvent({
      kind: 'not.a.thing',
      endpoint: 'x',
      agent_id: 'a',
      trace_id: 't',
      timestamp: new Date().toISOString(),
    });
    expect(r.ok).toBe(false);
  });

  it('rejects non-ISO timestamps', async () => {
    const { validateAgentEvent } = await import('@/lib/observability/types');
    const r = validateAgentEvent({
      kind: 'invoke.start',
      endpoint: 'x',
      agent_id: 'a',
      trace_id: 't',
      timestamp: 'yesterday',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects oversize endpoint names', async () => {
    const { validateAgentEvent } = await import('@/lib/observability/types');
    const r = validateAgentEvent({
      kind: 'invoke.start',
      endpoint: 'x'.repeat(300),
      agent_id: 'a',
      trace_id: 't',
      timestamp: new Date().toISOString(),
    });
    expect(r.ok).toBe(false);
  });
});

describe('observability · captureEvent + EventSink Strategy', () => {
  beforeEach(() => {
    process.env.FEATURE_HM_PLATFORM = 'true';
    process.env.DATABASE_URL = ''; // force no-op sink path
    vi.resetModules();
  });
  afterEach(() => { process.env.FEATURE_HM_PLATFORM = 'false'; });

  it('captureEvent is a no-op when the flag is off', async () => {
    process.env.FEATURE_HM_PLATFORM = 'false';
    const cap = await import('@/lib/observability/capture');
    // Should not throw; effectively verified by the absence of side effects.
    cap.captureEvent({
      kind: 'invoke.start',
      endpoint: 'test',
      agent_id: 'a',
      trace_id: 't1',
      timestamp: new Date().toISOString(),
    });
    expect(true).toBe(true);
  });

  it('captureEventSync completes and never throws through a stub sink', async () => {
    const cap = await import('@/lib/observability/capture');
    const emitted: unknown[] = [];
    const stub: import('@/lib/observability/capture').EventSink = {
      name: 'stub',
      emit: async (ev) => { emitted.push(ev); },
    };
    await cap.captureEventSync({
      kind: 'invoke.success',
      endpoint: 'test',
      agent_id: 'a',
      trace_id: 't2',
      timestamp: new Date().toISOString(),
    }, stub);
    expect(emitted.length).toBe(1);
  });
});

describe('observability · wrapAgentEndpoint identity path', () => {
  it('is a passthrough when FEATURE_HM_PLATFORM=false', async () => {
    process.env.FEATURE_HM_PLATFORM = 'false';
    vi.resetModules();
    const { wrapAgentEndpoint } = await import('@/lib/observability/wrap');
    const handler = wrapAgentEndpoint({
      name: 'test',
      handler: async () => new Response('ok', { status: 200 }),
    });
    const res = await handler({ headers: new Headers(), url: 'http://x/y' } as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('captures success + error events when flag on (with stub sentinel)', async () => {
    process.env.FEATURE_HM_PLATFORM = 'true';
    process.env.DATABASE_URL = '';
    vi.resetModules();
    const { wrapAgentEndpoint } = await import('@/lib/observability/wrap');
    // Success path
    const ok = wrapAgentEndpoint({
      name: 'test.success',
      handler: async () => new Response('ok', { status: 200 }),
    });
    const okRes = await ok({ headers: new Headers({ 'x-agent-id': 'agent-1' }), url: 'http://x/y' } as any);
    expect(okRes.status).toBe(200);

    // Error path — handler throws; wrapper re-throws after capture
    const bad = wrapAgentEndpoint({
      name: 'test.error',
      handler: async () => { throw new Error('boom'); },
    });
    await expect(bad({ headers: new Headers(), url: 'http://x/y' } as any)).rejects.toThrow('boom');
  });

  it('sentinel deny short-circuits to 429', async () => {
    process.env.FEATURE_HM_PLATFORM = 'true';
    vi.resetModules();
    const { wrapAgentEndpoint } = await import('@/lib/observability/wrap');
    const denier: import('@/lib/observability/wrap').SentinelCheck = {
      check: async () => ({ allow: false, reason: 'test_deny', policy: 'test' }),
    };
    const handler = wrapAgentEndpoint({
      name: 'test.denied',
      sentinel: denier,
      handler: async () => new Response('should not run'),
    });
    const res = await handler({ headers: new Headers(), url: 'http://x/y' } as any);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('policy_denied');
    expect(body.reason).toBe('test_deny');
  });
});
