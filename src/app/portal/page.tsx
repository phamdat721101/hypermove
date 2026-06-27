import type { Metadata } from 'next';
import Link from 'next/link';
import { readBundles } from '@/lib/bundles';
import BundleRequestForm from '@/components/BundleRequestForm';

export const metadata: Metadata = { title: 'Portal — Bundle catalog', description: 'Browse pre-built HyperMove bundles. Request one by email.' };

export default async function PortalPage() {
  const catalog = await readBundles();

  return (
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      {/* CTA: Generate */}
      <div className="mb-12 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-6">
        <h2 className="font-display text-xl font-bold text-white flex items-center gap-2">
          <span className="rounded bg-indigo-600 px-1.5 py-0.5 text-xs text-white">NEW</span>
          Generate MCP from any URL
        </h2>
        <p className="mt-2 text-sm text-gray-400">Paste a dApp link → scan → get a JSON MCP document for AI agents. No coding needed.</p>
        <Link href="/portal/generate" className="mt-4 inline-block rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors">
          Open Generator →
        </Link>
      </div>

      {/* Header */}
      <span className="inline-block rounded-full border border-gray-700 bg-gray-800/50 px-3 py-1 text-xs font-mono text-gray-400 uppercase tracking-wider">
        Portal · Bundle Catalog · v{catalog.version}
      </span>
      <h1 className="mt-4 font-display text-4xl font-bold text-white sm:text-5xl">
        Pick a bundle. <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">Get it by email.</span>
      </h1>
      <p className="mt-4 max-w-2xl text-gray-400">
        Pre-built HyperMove bundles cover the common shapes — x402 paywall, multi-chain settlement, BTC-as-treasury, paid MCP server. Each bundle is a self-contained <code className="font-mono text-indigo-400">npm install</code>-ready repo. Pick one, drop your email, we send the ZIP within minutes.
      </p>
      <p className="mt-3 text-xs text-gray-500 uppercase tracking-wider font-mono">
        Live download is paused for this phase — every request is reviewed by hand.
      </p>

      {/* Bundle grid */}
      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {catalog.bundles.map((b) => {
          const price = (b.default_price_micro_usdc / 1_000_000).toFixed(4);
          return (
            <div key={b.id} className="rounded-xl border border-gray-800 bg-gray-900/40 p-6 flex flex-col gap-4 h-full">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-xl font-semibold text-white">{b.name}</h2>
                  <p className="mt-1 text-sm text-gray-500">{b.tagline}</p>
                </div>
                <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-mono uppercase tracking-wider ${
                  b.difficulty === 'beginner' ? 'border-green-500/40 text-green-400' :
                  b.difficulty === 'intermediate' ? 'border-purple-500/40 text-purple-400' :
                  'border-red-500/40 text-red-400'
                }`}>
                  {b.difficulty}
                </span>
              </div>

              <p className="text-sm text-gray-500">{b.description}</p>

              <div className="grid grid-cols-2 gap-3 text-xs font-mono uppercase tracking-wider">
                <div>
                  <span className="text-gray-500">Files</span>
                  <p className="text-indigo-400">{b.files.length} · {b.size_kb} KB</p>
                </div>
                <div>
                  <span className="text-gray-500">Default Price</span>
                  <p className="text-indigo-400">${price} / call</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {b.chains.map((c) => (
                  <span key={c} className="rounded border border-gray-700 bg-gray-800/60 px-2 py-0.5 text-xs font-mono text-gray-300 uppercase">{c.replace(/-/g, ' ')}</span>
                ))}
                {b.protocols.map((p) => (
                  <span key={p} className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs font-mono text-cyan-400 uppercase">{p}</span>
                ))}
              </div>

              <div className="mt-auto">
                <BundleRequestForm bundleId={b.id} />
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-10 text-sm text-gray-500">
        Catalog also served machine-readable at{' '}
        <a href="/bundles.json" className="font-mono text-indigo-400 hover:text-indigo-300">/bundles.json</a>{' '}
        — agents can read it directly.
      </p>
    </div>
  );
}
