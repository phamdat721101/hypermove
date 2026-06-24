import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('hypermove-app · S2 + S2.1 ship-gate smoke', () => {
  it('every S2/S2.2 route file exists', () => {
    const required = [
      'src/app/api/agent/route.ts',
      'src/app/api/paid-endpoint/route.ts',
      'src/app/api/mcp/route.ts',
      'src/app/api/revenue/route.ts',
      'src/app/portal/page.tsx',
      'src/app/portal/actions.ts',
      'src/components/LiveAgentDemo.tsx',
      'src/components/CodeExamplePicker.tsx',
      'src/components/RevenueAndReceipt.tsx',
      'src/components/BundleRequestForm.tsx',
      'src/lib/agent.ts',
      'src/lib/cache.ts',
      'src/lib/bundles.ts',
      'src/lib/db.ts',
      'public/bundles.json',
    ];
    for (const f of required) expect(exists(f), `missing: ${f}`).toBe(true);
  });

  it('agent.ts exports the LiveAgentSource strategy + 9 frames', () => {
    const src = read('src/lib/agent.ts');
    expect(src).toContain('LiveAgentSource');
    expect(src).toContain('MockSource');
    expect(src).toContain('AnthropicSource');
    const frameMatches = src.match(/kind: '[a-z0-9.]+'/g) ?? [];
    expect(frameMatches.length).toBeGreaterThanOrEqual(9);
  });

  it('/api/paid-endpoint emits the canonical x402-USDC contract', () => {
    const src = read('src/app/api/paid-endpoint/route.ts');
    expect(src).toContain('x402-USDC');
    expect(src).toContain('www-authenticate');
    expect(src).toContain('402');
  });

  it('.well-known/webmcp.json advertises 2 tools (post-S2)', () => {
    const manifest = JSON.parse(read('public/.well-known/webmcp.json'));
    expect(manifest.tools).toHaveLength(2);
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'payment.x402',
      'reputation.read',
    ]);
  });

  it('cache TtlLruCache + DailyBudget behave correctly', async () => {
    const { TtlLruCache, DailyBudget } = await import('@/lib/cache');
    const c = new TtlLruCache<number>(2, 1_000);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);

    const budget = new DailyBudget(0.01);
    expect(budget.consume(0.005)).toBe(true);
    expect(budget.consume(0.005)).toBe(true);
    expect(budget.consume(0.001)).toBe(false);
  });

  it('bundles catalog parses + has ≥3 bundles with required fields', async () => {
    const { readBundles } = await import('@/lib/bundles');
    const catalog = await readBundles();
    expect(catalog.publisher).toBe('hypermove.dev');
    expect(catalog.bundles.length).toBeGreaterThanOrEqual(3);
    for (const b of catalog.bundles) {
      expect(b.id).toMatch(/^[a-z0-9-]+$/);
      expect(b.files.length).toBeGreaterThan(0);
      expect(b.default_price_micro_usdc).toBeGreaterThan(0);
      expect(['beginner', 'intermediate', 'advanced']).toContain(b.difficulty);
    }
  });

  it('db.ts no-ops gracefully when DATABASE_URL is unset', async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const { insertRegistryRequest } = await import('@/lib/db');
    const r = await insertRegistryRequest({ email: 'x@y.z', bundleId: 'x402-base-starter' });
    expect(r.ok).toBe(true);
    expect(r.noopReason).toBe('no_database_url');
    if (original !== undefined) process.env.DATABASE_URL = original;
  });

  it('registerBundleRequest Server Action rejects bad email + unknown bundle', async () => {
    const { registerBundleRequest } = await import('@/app/portal/actions');

    const r1 = await registerBundleRequest({ email: 'not-an-email', bundleId: 'x402-base-starter' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toBe('invalid_email');

    const r2 = await registerBundleRequest({ email: 'a@b.co', bundleId: 'does-not-exist' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('unknown_bundle');
  });
});
