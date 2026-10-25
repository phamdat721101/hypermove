// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('pg'); vi.resetModules(); });
describe('research database transport', () => {
  it('forces verified remote TLS and strips insecure URI overrides', async () => {
    vi.resetModules(); const connect = vi.fn(async () => ({ query: vi.fn(), release: vi.fn() })); const constructor = vi.fn();
    vi.doMock('pg', () => ({ Pool: class { constructor(options: unknown) { constructor(options); } connect = connect; on = vi.fn(); } }));
    vi.stubEnv('DATABASE_URL', 'postgresql://user@example.com/research?sslmode=no-verify');
    const { withClient } = await import('../src/lib/db'); expect(await withClient(async () => true, { verifiedTls: true, skipSchema: true })).toBe(true);
    const options = constructor.mock.calls[0][0] as { ssl: { rejectUnauthorized: boolean }; connectionString: string };
    expect(options.ssl.rejectUnauthorized).toBe(true); expect(options.connectionString).not.toContain('no-verify');
  });
});
