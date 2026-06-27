import type { Metadata } from 'next';
import Link from 'next/link';
import { readBundles } from '@/lib/bundles';

export const metadata: Metadata = { title: 'Catalog' };

export default async function PortalPage() {
  const catalog = await readBundles();

  return (
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      {/* CTA to generate */}
      <div className="mb-12 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-6 text-center">
        <h2 className="font-display text-2xl font-bold text-white">Generate MCP from any URL</h2>
        <p className="mt-2 text-sm text-gray-400">Paste a link → AI analyzes → get MCP server. No coding needed.</p>
        <Link href="/portal/generate" className="mt-4 inline-flex items-center rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors">
          Open Generator →
        </Link>
      </div>

      <h1 className="font-display text-3xl font-bold text-white mb-8">Pre-built Templates</h1>
      <div className="grid gap-6 md:grid-cols-2">
        {catalog.bundles.map((b) => (
          <div key={b.id} className="rounded-xl border border-gray-800 bg-gray-900/40 p-6 hover:border-gray-700 transition-colors">
            <h3 className="font-display text-lg font-semibold text-white">{b.name}</h3>
            <p className="mt-1 text-sm text-gray-400">{b.tagline}</p>
            <p className="mt-3 text-xs text-gray-500">{b.description}</p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {b.chains.slice(0, 3).map((c) => (
                <span key={c} className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">{c}</span>
              ))}
              {b.protocols.slice(0, 2).map((p) => (
                <span key={p} className="rounded bg-indigo-900/30 px-2 py-0.5 text-xs text-indigo-400">{p}</span>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between text-xs text-gray-500">
              <span>{b.files.length} files · {b.size_kb} KB</span>
              <span className={`font-medium ${b.difficulty === 'beginner' ? 'text-green-400' : b.difficulty === 'intermediate' ? 'text-yellow-400' : 'text-red-400'}`}>
                {b.difficulty}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
