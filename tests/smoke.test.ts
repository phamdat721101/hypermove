import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('hypermove-app · S1 scaffold smoke', () => {
  it('package.json declares next 14 and all required scripts', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.name).toBe('hypermove-app');
    expect(pkg.dependencies.next).toMatch(/^14/);
    expect(pkg.scripts.dev).toMatch(/next dev/);
    expect(pkg.scripts.build).toMatch(/next build/);
    expect(pkg.scripts.test).toMatch(/vitest/);
    expect(pkg.scripts.report).toMatch(/report\.mjs/);
    expect(pkg.dependencies.pg).toBeTruthy();
    expect(pkg.dependencies.jszip).toBeUndefined();
  });

  it('tailwind config encodes HyperMove design tokens (single source)', () => {
    const cfg = read('tailwind.config.mjs');
    expect(cfg).toContain('#0b1326');
    expect(cfg).toContain('#7c3aed');
    expect(cfg).toContain('#5de6ff');
    expect(cfg).toContain('#4edea3');
  });

  it('every required route file exists post-S2.1', () => {
    const routes = [
      'src/app/layout.tsx',
      'src/app/page.tsx',
      'src/app/docs/layout.tsx',
      'src/app/docs/n-payment/page.mdx',
      'src/app/docs/quickstart/page.mdx',
      'src/app/pricing/page.tsx',
      'src/app/portal/page.tsx',
      'src/app/dashboard/page.tsx',
      'src/app/registry/page.tsx',
      'public/.well-known/webmcp.json',
      'public/.well-known/agent.json',
      'public/bundles.json',
    ];
    for (const r of routes) expect(exists(r), `missing: ${r}`).toBe(true);
  });

  it('dead files are removed (webmcp doc, scanner, zip)', () => {
    const removed = [
      'src/app/docs/webmcp/page.mdx',
      'src/app/api/v1/scan/route.ts',
      'src/app/api/v1/generate/route.ts',
      'src/lib/scanner.ts',
      'src/lib/zip-generator.ts',
    ];
    for (const r of removed) expect(exists(r), `should be removed: ${r}`).toBe(false);
  });

  it('.well-known/webmcp.json is independent (no GOAT framing)', () => {
    const manifest = JSON.parse(read('public/.well-known/webmcp.json'));
    expect(manifest.name).toBe('hypermove.dev');
    expect(manifest.version).toBe('0.3');
    expect(JSON.stringify(manifest)).not.toMatch(/GOAT.*Builder.*Grant/i);
  });

  it('Hero component contains the locked headline + neutral framing', () => {
    const hero = read('src/components/Hero.tsx');
    expect(hero).toMatch(/agent-callable in/);
    expect(hero).toMatch(/3 lines of HTML/);
    expect(hero).not.toMatch(/funded by GOAT/i);
  });

  it('nav-config exports the locked external links', () => {
    const nav = read('src/lib/nav-config.ts');
    expect(nav).toContain('https://www.npmjs.com/package/n-payment');
    expect(nav).toContain('https://github.com/phamdat721101');
    expect(nav).toContain('https://calendly.com/phamdat721101/30min');
  });

  it('no GOAT branding remains in app source (text scan)', () => {
    const files = [
      'src/app/layout.tsx',
      'src/components/Hero.tsx',
      'src/components/FooterGoatBadge.tsx',
      'public/.well-known/agent.json',
      'README.md',
    ];
    for (const f of files) {
      const txt = read(f);
      expect(txt, `${f} still mentions GOAT funding`).not.toMatch(/funded by GOAT|GOAT AI Builder/i);
    }
  });

  it('tracking/task-log.json includes the S2.1 upgrade tasks', () => {
    const log = JSON.parse(read('tracking/task-log.json'));
    expect(log.tasks.length).toBeGreaterThanOrEqual(27);
    const sprints = new Set(log.tasks.map((t: { sprint: string }) => t.sprint));
    expect(sprints.has('S1')).toBe(true);
    expect(sprints.has('S2')).toBe(true);
  });
});
