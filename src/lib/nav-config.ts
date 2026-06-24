/**
 * src/lib/nav-config.ts — navigation + external link data.
 * Every consumer (TopNav, FooterGoatBadge, Hero, stubs) reads from these constants only.
 * Changing a URL here propagates everywhere — single source of truth.
 */

export interface NavLink {
  href: string;
  label: string;
  /** Marks the route as part of S3+; renders a "Soon" chip when true. */
  soon?: boolean;
}

export const TOP_NAV: readonly NavLink[] = [
  { href: '/', label: 'Product' },
  { href: '/docs/quickstart', label: 'Docs' },
  { href: '/portal', label: 'Portal' },
  { href: '/registry', label: 'Registry', soon: true },
  { href: '/pricing', label: 'Pricing' },
];

export interface DocsSection {
  title: string;
  links: readonly NavLink[];
}

export const DOCS_NAV: readonly DocsSection[] = [
  {
    title: 'Get started',
    links: [{ href: '/docs/quickstart', label: 'Quickstart — 5 min' }],
  },
  {
    title: 'n-payment',
    links: [{ href: '/docs/n-payment', label: 'fetchWithPayment() + 14 protocols' }],
  },
];

// -- External links (single source of truth) ---------------------------------
export const NPM_PACKAGE_URL = 'https://www.npmjs.com/package/n-payment';
export const GITHUB_URL = 'https://github.com/phamdat721101';
export const BOOK_DEMO_URL = 'https://calendly.com/phamdat721101/30min';
