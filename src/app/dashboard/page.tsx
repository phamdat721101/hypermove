import Link from 'next/link';
import type { Metadata } from 'next';
import { BOOK_DEMO_URL } from '@/lib/nav-config';

export const metadata: Metadata = { title: 'Dashboard (S3)' };

export default function DashboardPage() {
  return (
    <ComingSoon
      title="Dashboard"
      sprint="Sprint 3"
      blurb="Per-MCP analytics, on-chain USDC ledger, and payout history."
    />
  );
}

export function ComingSoon({ title, sprint, blurb }: { title: string; sprint: string; blurb: string }) {
  return (
    <div className="mx-auto max-w-container px-margin-mobile py-24 md:px-margin-desktop">
      <nav aria-label="Breadcrumb" className="mb-6 text-label-mono uppercase tracking-wider text-on-surface-variant">
        <Link href="/" className="hover:text-primary">Home</Link> &nbsp;/&nbsp; <span className="text-on-surface">{title}</span>
      </nav>
      <h1 className="text-display-lg-mobile font-bold tracking-tight text-on-surface md:text-display-lg">
        {title}
      </h1>
      <p className="mt-4 max-w-xl text-body-base text-on-surface-variant">{blurb}</p>
      <div className="mt-6 inline-flex items-center gap-3 rounded-lg border border-outline-variant/40 bg-surface-container-low/60 px-4 py-3">
        <span className="chip border border-secondary-container/60 bg-secondary-container/15 text-secondary">{sprint}</span>
        <span className="text-body-sm text-on-surface-variant">Lands after the S2 ship-gate.</span>
      </div>
      <div className="mt-10 flex flex-wrap gap-3">
        <Link href="/portal" className="btn-primary">Browse bundles</Link>
        <a href={BOOK_DEMO_URL} target="_blank" rel="noreferrer" className="btn-ghost">
          Book early access
        </a>
      </div>
    </div>
  );
}
