import Link from 'next/link';
import Image from 'next/image';
import { GITHUB_URL, NPM_PACKAGE_URL, BOOK_DEMO_URL } from '@/lib/nav-config';

/**
 * Footer — neutral OSS framing. HyperMove ships as an independent product.
 * (Filename retained from the scaffold to avoid churning every import; the badge content
 *  is now an MIT/npm chip rather than a funding callout.)
 */
export default function FooterGoatBadge() {
  return (
    <footer className="mt-24 border-t border-outline-variant/30 bg-surface-container-lowest/40">
      <div className="mx-auto flex max-w-container flex-col gap-6 px-margin-mobile py-10 md:px-margin-desktop md:flex-row md:items-center md:justify-between">
        <a
          href={NPM_PACKAGE_URL}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-3 rounded-lg border border-outline-variant/30 bg-surface-container-low/60 px-4 py-2.5 backdrop-blur-glass transition-colors hover:border-primary-container/60 hover:bg-surface-container-high"
        >
          <Image
            src="/logo.png"
            alt=""
            width={36}
            height={36}
            className="h-9 w-9 rounded-md bg-white p-0.5"
          />
          <div className="flex flex-col leading-tight">
            <span className="text-label-mono uppercase tracking-wider text-on-surface-variant">
              Open source · MIT
            </span>
            <span className="text-body-sm font-semibold text-on-surface group-hover:text-primary">
              n-payment on npm — 27 chains, 14 protocols
            </span>
          </div>
          <span aria-hidden="true" className="text-secondary">→</span>
        </a>

        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-body-sm text-on-surface-variant">
          <a href={NPM_PACKAGE_URL} target="_blank" rel="noreferrer" className="hover:text-primary">
            npm
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-primary">
            GitHub
          </a>
          <a href={BOOK_DEMO_URL} target="_blank" rel="noreferrer" className="hover:text-primary">
            Book a demo
          </a>
          <Link href="/docs/quickstart" className="hover:text-primary">Quickstart</Link>
          <Link href="/pricing" className="hover:text-primary">Pricing</Link>
          <span className="text-label-mono uppercase tracking-wider text-outline">v0.1.0 · MIT</span>
        </nav>
      </div>
    </footer>
  );
}
