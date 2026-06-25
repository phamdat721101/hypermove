import type { Metadata } from 'next';
import { readBundles, type Bundle } from '@/lib/bundles';
import ChainBadge from '@/components/ChainBadge';
import ProtocolBadge from '@/components/ProtocolBadge';
import BundleRequestForm from '@/components/BundleRequestForm';

export const metadata: Metadata = {
  title: 'Portal — bundle catalog',
  description: 'Browse pre-built HyperMove bundles. Request one by email.',
};

export default async function PortalPage() {
  const catalog = await readBundles();

  return (
    <div className="mx-auto max-w-container px-margin-mobile py-16 md:px-margin-desktop md:py-20">
      {/* ─── CTA: Generate from URL (the flow NIM requested) ─── */}
      <div className="mb-12 rounded-xl border border-primary/30 bg-primary/5 p-6">
        <h2 className="text-xl font-bold text-on-surface">
          🆕 Generate MCP from any URL
        </h2>
        <p className="mt-2 text-sm text-on-surface-variant">
          Paste a dApp link → scan → get a JSON MCP document for AI agents. No coding needed.
        </p>
        <a
          href="/portal/generate"
          className="mt-4 inline-block rounded-lg bg-primary px-6 py-2.5 font-medium text-on-primary hover:opacity-90"
        >
          Open Generator →
        </a>
      </div>

      <header className="mb-10">
        <span className="chip border border-outline-variant/40 bg-surface-container-high/40 text-on-surface-variant">
          Portal · bundle catalog · v{catalog.version}
        </span>
        <h1 className="mt-4 text-display-lg-mobile font-bold tracking-tight text-on-surface md:text-display-lg">
          Pick a bundle. <span className="gradient-text-purple-cyan">Get it by email.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-body-base text-on-surface-variant">
          Pre-built HyperMove bundles cover the common shapes — x402 paywall, multi-chain settlement, BTC-as-treasury,
          paid MCP server. Each bundle is a self-contained {''}
          <code className="font-mono text-secondary">npm install</code>-ready repo.
          Pick one, drop your email, we send the ZIP within minutes.
        </p>
        <p className="mt-3 max-w-2xl text-label-mono uppercase tracking-wider text-on-surface-variant">
          Live download is paused for this phase — every request is reviewed by hand.
        </p>
      </header>

      <ul className="grid gap-gutter md:grid-cols-2">
        {catalog.bundles.map((b) => (
          <BundleCard key={b.id} bundle={b} />
        ))}
      </ul>

      <p className="mt-12 text-body-sm text-on-surface-variant">
        Catalog also served machine-readable at{' '}
        <a href="/bundles.json" className="font-mono text-secondary hover:text-primary">
          /bundles.json
        </a>{' '}
        — agents can read it directly.
      </p>
    </div>
  );
}

function BundleCard({ bundle }: { bundle: Bundle }) {
  const price = (bundle.default_price_micro_usdc / 1_000_000).toFixed(4);
  return (
    <li className="glass-panel flex flex-col gap-4 rounded-lg p-6 neon-hover">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-headline-md font-semibold text-on-surface">{bundle.name}</h2>
          <p className="mt-1 text-body-sm text-on-surface-variant">{bundle.tagline}</p>
        </div>
        <span
          className={`chip border text-label-mono ${
            bundle.difficulty === 'beginner'
              ? 'border-tertiary/40 bg-tertiary-container/15 text-tertiary'
              : bundle.difficulty === 'intermediate'
                ? 'border-secondary-container/40 bg-secondary-container/15 text-secondary'
                : 'border-primary-container/40 bg-primary-container/15 text-primary'
          }`}
        >
          {bundle.difficulty}
        </span>
      </header>

      <p className="text-body-sm text-on-surface-variant">{bundle.description}</p>

      <dl className="grid grid-cols-2 gap-3 text-label-mono uppercase tracking-wider">
        <div>
          <dt className="text-on-surface-variant">Files</dt>
          <dd className="font-mono text-secondary">{bundle.files.length} · {bundle.size_kb} KB</dd>
        </div>
        <div>
          <dt className="text-on-surface-variant">Default price</dt>
          <dd className="font-mono text-secondary">${price} / call</dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-1.5">
        {bundle.chains.map((c) => (
          <ChainBadge key={c} chainId={c} size="sm" />
        ))}
        {bundle.protocols.map((p) => (
          <ProtocolBadge key={p} protocolId={p} size="sm" />
        ))}
      </div>

      <BundleRequestForm bundleId={bundle.id} />
    </li>
  );
}
