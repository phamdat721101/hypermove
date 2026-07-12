/**
 * src/lib/nav-config.ts — external link constants + docs sub-nav data.
 *
 * NOTE: the top nav bar itself is NOT driven by TOP_NAV below — it's
 * hardcoded in src/components/Navbar.tsx (`navItems`). TOP_NAV exists for
 * any future consumer that wants the top-level route list; keep it in sync
 * with Navbar.tsx's navItems by hand until one is refactored to import the
 * other. DOCS_NAV and the external-link constants ARE the real source of
 * truth for their respective consumers.
 */

export interface NavLink {
  href: string;
  label: string;
  /** Marks the route as part of S3+; renders a "Soon" chip when true. */
  soon?: boolean;
}

export const TOP_NAV: readonly NavLink[] = [
  { href: '/', label: 'Home' },
  { href: '/docs', label: 'Docs' },
  { href: '/mcp-connect', label: 'Connect' },
  { href: '/tools', label: 'Tools' },
  { href: '/registry', label: 'Registry', soon: true },
  { href: '/pricing', label: 'Pricing' },
];

export interface DocsSection {
  title: string;
  links: readonly NavLink[];
}

export const DOCS_NAV: readonly DocsSection[] = [
  {
    title: 'Overview',
    links: [{ href: '/docs', label: 'Introduction' }],
  },
  {
    title: 'Get started',
    links: [{ href: '/docs/quickstart', label: 'Quickstart — 5 min' }],
  },
  {
    title: 'Platform',
    links: [{ href: '/docs/mcp-gateway', label: 'MCP Gateway' }],
  },
  {
    title: 'Payments',
    links: [{ href: '/docs/n-payment', label: 'n-payment SDK' }],
  },
];

// -- External links (single source of truth) ---------------------------------
export const NPM_PACKAGE_URL = 'https://www.npmjs.com/package/n-payment';
export const GITHUB_URL = 'https://github.com/phamdat721101';
export const BOOK_DEMO_URL = 'https://calendly.com/phamdat721101/30min';
