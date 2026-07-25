/**
 * tests/mcp-device-auth.test.ts
 * ------------------------------
 * Terminal device-code auth (FEATURE_MCP_DEVICE_AUTH): the full
 * start -> approve -> poll lifecycle, one-shot enforcement, idempotent token
 * issuance, per-IP rate limiting, flag-off rollback, and the device-kind
 * free-tier hard cap in auth.ts's validateToken().
 *
 * Hermetic (no real DATABASE_URL): mirrors tests/mcp-tee-instruct-token-profile
 * .test.ts's convention of a stateful in-memory fake driven by SQL string
 * matching through a mocked withClient(), since this flow's correctness
 * (one-shot, idempotent mint) is inherently a persistence-state question that
 * a DB-absent no-op (`withClient() -> null`) can't exercise at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const origEnv = process.env;

interface DeviceRow {
  device_code: string;
  user_code: string;
  status: string;
  token_hash: string | null;
  expires_at: string;
}

interface TokenRow {
  token_hash: string;
  user_id: string;
  email: string | null;
  expires_at: string;
}

interface RateRow {
  bucket_key: string;
  user_id: string;
  hour_bucket: number;
  count: number;
}

/** Fresh in-memory fake DB state per test — install via vi.doMock before each import. */
function installFakeDb() {
  const deviceRows: DeviceRow[] = [];
  const tokenRows: TokenRow[] = [];
  const rateRows: RateRow[] = [];
  const userRows: { workos_user_id: string; email: string | null; tier: string }[] = [];

  vi.doMock('../src/lib/db', () => ({
    withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      const client = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          // ── mcp_device_codes ────────────────────────────────────────────
          if (sql.includes('INSERT INTO mcp_device_codes')) {
            deviceRows.push({ device_code: params[0] as string, user_code: params[1] as string, status: 'pending', token_hash: null, expires_at: params[2] as string });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SELECT status, expires_at::text FROM mcp_device_codes WHERE user_code')) {
            const row = deviceRows.find((r) => r.user_code === params[0]);
            return { rows: row ? [{ status: row.status, expires_at: row.expires_at }] : [] };
          }
          if (sql.includes('SELECT status, expires_at::text, token_hash FROM mcp_device_codes WHERE device_code')) {
            const row = deviceRows.find((r) => r.device_code === params[0]);
            return { rows: row ? [{ status: row.status, expires_at: row.expires_at, token_hash: row.token_hash }] : [] };
          }
          if (sql.startsWith("UPDATE mcp_device_codes SET status = 'expired' WHERE user_code")) {
            const row = deviceRows.find((r) => r.user_code === params[0] && r.status === 'pending');
            if (row) row.status = 'expired';
            return { rows: [], rowCount: row ? 1 : 0 };
          }
          if (sql.startsWith("UPDATE mcp_device_codes SET status = 'expired' WHERE device_code")) {
            const row = deviceRows.find((r) => r.device_code === params[0] && r.status === 'pending');
            if (row) row.status = 'expired';
            return { rows: [], rowCount: row ? 1 : 0 };
          }
          if (sql.includes("UPDATE mcp_device_codes SET status = $1 WHERE user_code = $2 AND status = 'pending'")) {
            const row = deviceRows.find((r) => r.user_code === params[1] && r.status === 'pending');
            if (row) row.status = params[0] as string;
            return { rows: [], rowCount: row ? 1 : 0 };
          }
          if (sql.includes("UPDATE mcp_device_codes SET token_hash = $1 WHERE device_code = $2 AND status = 'approved' AND token_hash IS NULL")) {
            const row = deviceRows.find((r) => r.device_code === params[1] && r.status === 'approved' && r.token_hash === null);
            if (row) row.token_hash = params[0] as string;
            return { rows: [], rowCount: row ? 1 : 0 };
          }

          // ── mcp_users / mcp_tokens (storeToken, mirrors auth.ts's real SQL) ──
          if (sql.includes('INSERT INTO mcp_users')) {
            const existing = userRows.find((u) => u.workos_user_id === params[0]);
            if (existing) existing.email = (params[1] as string | null) ?? existing.email;
            else userRows.push({ workos_user_id: params[0] as string, email: (params[1] as string | null) ?? null, tier: 'free' });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('INSERT INTO mcp_tokens')) {
            tokenRows.push({ token_hash: params[0] as string, user_id: params[1] as string, email: (params[2] as string | null) ?? null, expires_at: params[3] as string });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SELECT t.user_id, t.email, u.tier')) {
            const t = tokenRows.find((row) => row.token_hash === params[0] && new Date(row.expires_at) > new Date());
            if (!t) return { rows: [] };
            const u = userRows.find((row) => row.workos_user_id === t.user_id);
            return { rows: [{ user_id: t.user_id, email: t.email, tier: u?.tier ?? null }] };
          }

          // ── mcp_rate_counters (device-start per-IP limiter) ─────────────
          if (sql.includes('SELECT COALESCE(SUM(count),0) AS total FROM mcp_rate_counters')) {
            const [userId, oldest, bucket] = params as [string, number, number];
            const total = rateRows.filter((r) => r.user_id === userId && r.hour_bucket >= oldest && r.hour_bucket <= bucket).reduce((s, r) => s + r.count, 0);
            return { rows: [{ total: String(total) }] };
          }
          if (sql.includes('INSERT INTO mcp_rate_counters')) {
            const [bucketKey, userId, hourBucket] = params as [string, string, number];
            const existing = rateRows.find((r) => r.bucket_key === bucketKey);
            if (existing) existing.count += 1;
            else rateRows.push({ bucket_key: bucketKey, user_id: userId, hour_bucket: hourBucket, count: 1 });
            return { rows: [], rowCount: 1 };
          }

          throw new Error(`fake db: unhandled query: ${sql}`);
        }),
      };
      return fn(client);
    }),
  }));

  return { deviceRows, tokenRows, rateRows, userRows };
}

beforeEach(() => {
  process.env = { ...origEnv, FEATURE_HYPERMOVE_MCP_GATEWAY_V1: 'true', FEATURE_MCP_DEVICE_AUTH: 'true' };
  vi.resetModules();
});

afterEach(() => {
  process.env = origEnv;
  vi.doUnmock('../src/lib/db');
  vi.restoreAllMocks();
});

describe('device-auth: flag gate', () => {
  it('issueDeviceCode returns feature_disabled when FEATURE_MCP_DEVICE_AUTH=false', async () => {
    process.env.FEATURE_MCP_DEVICE_AUTH = 'false';
    installFakeDb();
    const { issueDeviceCode } = await import('../src/lib/mcp/device-auth');
    const res = await issueDeviceCode();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('feature_disabled');
  });

  it('resolveDeviceCode and pollDeviceCode also respect the flag', async () => {
    process.env.FEATURE_MCP_DEVICE_AUTH = 'false';
    installFakeDb();
    const { resolveDeviceCode, pollDeviceCode } = await import('../src/lib/mcp/device-auth');
    const a = await resolveDeviceCode('ABCD-1234', 'y');
    const b = await pollDeviceCode('whatever');
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });
});

describe('device-auth: issueDeviceCode', () => {
  it('two calls produce distinct, unpredictable device_code and user_code pairs', async () => {
    installFakeDb();
    const { issueDeviceCode } = await import('../src/lib/mcp/device-auth');
    const a = await issueDeviceCode();
    const b = await issueDeviceCode();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.data.device_code).not.toBe(b.data.device_code);
      expect(a.data.user_code).not.toBe(b.data.user_code);
      expect(a.data.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(a.data.expires_in).toBe(300);
      expect(a.data.interval).toBe(5);
    }
  });
});

describe('device-auth: full lifecycle (start -> approve -> poll)', () => {
  it('pending -> approved -> token issued -> idempotent repeat poll returns the SAME token', async () => {
    installFakeDb();
    const { issueDeviceCode, resolveDeviceCode, pollDeviceCode } = await import('../src/lib/mcp/device-auth');

    const started = await issueDeviceCode();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { device_code, user_code } = started.data;

    const firstPoll = await pollDeviceCode(device_code);
    expect(firstPoll.ok).toBe(true);
    if (firstPoll.ok) expect(firstPoll.data.status).toBe('pending');

    const approved = await resolveDeviceCode(user_code, 'y');
    expect(approved.ok).toBe(true);
    if (approved.ok) expect(approved.data.status).toBe('approved');

    const secondPoll = await pollDeviceCode(device_code);
    expect(secondPoll.ok).toBe(true);
    if (!secondPoll.ok) return;
    expect(secondPoll.data.status).toBe('approved');
    expect(secondPoll.data.token).toBeTruthy();
    expect(secondPoll.data.token_type).toBe('Bearer');

    const thirdPoll = await pollDeviceCode(device_code);
    expect(thirdPoll.ok).toBe(true);
    if (!thirdPoll.ok) return;
    expect(thirdPoll.data.token).toBe(secondPoll.data.token); // idempotent — not a new mint
  });

  it('denied -> poll reports denied, no token', async () => {
    installFakeDb();
    const { issueDeviceCode, resolveDeviceCode, pollDeviceCode } = await import('../src/lib/mcp/device-auth');
    const started = await issueDeviceCode();
    if (!started.ok) return;
    const { device_code, user_code } = started.data;

    const denied = await resolveDeviceCode(user_code, 'n');
    expect(denied.ok).toBe(true);
    if (denied.ok) expect(denied.data.status).toBe('denied');

    const poll = await pollDeviceCode(device_code);
    expect(poll.ok).toBe(true);
    if (poll.ok) {
      expect(poll.data.status).toBe('denied');
      expect(poll.data.token).toBeUndefined();
    }
  });

  it('is one-shot: a second approve call on an already-resolved user_code is rejected, not silently re-applied', async () => {
    installFakeDb();
    const { issueDeviceCode, resolveDeviceCode } = await import('../src/lib/mcp/device-auth');
    const started = await issueDeviceCode();
    if (!started.ok) return;
    const { user_code } = started.data;

    const first = await resolveDeviceCode(user_code, 'y');
    expect(first.ok).toBe(true);

    const second = await resolveDeviceCode(user_code, 'n'); // even a DIFFERENT decision must not flip it
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('already_resolved');
  });

  it('rejects approve on an unknown user_code with not_found', async () => {
    installFakeDb();
    const { resolveDeviceCode } = await import('../src/lib/mcp/device-auth');
    const res = await resolveDeviceCode('ZZZZ-9999', 'y');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
  });

  it('rejects poll on an unknown device_code with not_found', async () => {
    installFakeDb();
    const { pollDeviceCode } = await import('../src/lib/mcp/device-auth');
    const res = await pollDeviceCode('nonexistent-device-code');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
  });

  it('an expired-without-approval code cannot be approved, and poll reports expired', async () => {
    installFakeDb();
    const { issueDeviceCode, resolveDeviceCode, pollDeviceCode } = await import('../src/lib/mcp/device-auth');
    const started = await issueDeviceCode();
    if (!started.ok) return;
    const { device_code, user_code } = started.data;

    // Simulate elapsed time past the 5-minute TTL rather than mutating the
    // fake row directly (resolveDeviceCode/pollDeviceCode both compare
    // expires_at against `new Date()`, so fake-timers is the honest way to
    // exercise the real expiry-check code path, not a shortcut around it).
    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60_000);

    const approveAttempt = await resolveDeviceCode(user_code, 'y');
    expect(approveAttempt.ok).toBe(false);
    if (!approveAttempt.ok) expect(approveAttempt.error.code).toBe('expired');

    const poll = await pollDeviceCode(device_code);
    expect(poll.ok).toBe(true);
    if (poll.ok) expect(poll.data.status).toBe('expired');

    vi.useRealTimers();
  });
});

describe('device-auth: per-IP rate limiting on /device/start', () => {
  it('allows up to the limit then rejects further starts from the same IP within the window', async () => {
    installFakeDb();
    const { checkAndConsumeDeviceStart, DEVICE_START_LIMIT_PER_IP } = await import('../src/lib/mcp/rate-limit-device');
    const ip = '203.0.113.42';
    for (let i = 0; i < DEVICE_START_LIMIT_PER_IP; i++) {
      const r = await checkAndConsumeDeviceStart(ip);
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkAndConsumeDeviceStart(ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.used).toBe(DEVICE_START_LIMIT_PER_IP);
  });

  it('tracks separate IPs independently', async () => {
    installFakeDb();
    const { checkAndConsumeDeviceStart } = await import('../src/lib/mcp/rate-limit-device');
    const a = await checkAndConsumeDeviceStart('203.0.113.1');
    const b = await checkAndConsumeDeviceStart('203.0.113.2');
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(a.used).toBe(1);
    expect(b.used).toBe(1);
  });
});

describe('device-auth: kind + tier hard cap in auth.ts', () => {
  it('a device-issued token resolves to kind:"device" and tier:"free" via authenticate()/validateToken(), never above free', async () => {
    installFakeDb();
    const { issueDeviceCode, resolveDeviceCode, pollDeviceCode } = await import('../src/lib/mcp/device-auth');
    const started = await issueDeviceCode();
    if (!started.ok) return;
    await resolveDeviceCode(started.data.user_code, 'y');
    const polled = await pollDeviceCode(started.data.device_code);
    expect(polled.ok).toBe(true);
    if (!polled.ok || !polled.data.token) return;

    process.env.FEATURE_MCP_AUTH_WORKOS = 'true';
    const { authenticate } = await import('../src/lib/mcp/auth');
    const req = new Request('http://localhost/api/mcp', {
      headers: { authorization: `Bearer ${polled.data.token}` },
    }) as unknown as import('next/server').NextRequest;

    const outcome = await authenticate(req);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.session.kind).toBe('device');
      expect(outcome.session.tier).toBe('free');
      expect(outcome.session.userId).toMatch(/^device:/);
    }
  });

  it('even if mcp_users.tier were somehow set to "paid" for a device: identity, validateToken() still forces tier:"free"', async () => {
    const state = installFakeDb();
    const { issueDeviceCode, resolveDeviceCode, pollDeviceCode } = await import('../src/lib/mcp/device-auth');
    const started = await issueDeviceCode();
    if (!started.ok) return;
    await resolveDeviceCode(started.data.user_code, 'y');
    const polled = await pollDeviceCode(started.data.device_code);
    if (!polled.ok || !polled.data.token) return;

    // Simulate a hypothetical future upgrade path writing 'paid' onto the row directly.
    const userRow = state.userRows.find((u) => u.workos_user_id.startsWith('device:'));
    if (userRow) userRow.tier = 'paid';

    process.env.FEATURE_MCP_AUTH_WORKOS = 'true';
    const { authenticate } = await import('../src/lib/mcp/auth');
    const req = new Request('http://localhost/api/mcp', {
      headers: { authorization: `Bearer ${polled.data.token}` },
    }) as unknown as import('next/server').NextRequest;

    const outcome = await authenticate(req);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.session.kind).toBe('device');
      expect(outcome.session.tier).toBe('free'); // hard cap holds regardless of the row's tier column
    }
  });
});
