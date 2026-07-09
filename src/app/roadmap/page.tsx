import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'iOS-parallel roadmap · HyperMove',
  description: 'Apple iOS provides 12 platform primitives for apps. HyperMove targets full parity for AI agents.',
};

interface Primitive {
  n: number;
  ios: string;
  hypermove: string;
  status: 'shipped' | 'v2' | 'q4' | 'q1';
  note?: string;
}

const PRIMITIVES: readonly Primitive[] = [
  { n: 1,  ios: 'Hardware abstraction',       hypermove: 'Chain abstraction (27+ chains × 14 protocols)',   status: 'shipped' },
  { n: 2,  ios: 'App distribution',           hypermove: 'OpenX marketplace (sister product)',              status: 'shipped' },
  { n: 3,  ios: 'Inter-app connectivity',     hypermove: 'WebMCP + .well-known/webmcp.json + MCP Apps',     status: 'shipped' },
  { n: 4,  ios: 'Payment rail',               hypermove: 'n-payment SDK (x402 + AP2 + 5 stablecoin rails)', status: 'shipped' },
  { n: 5,  ios: 'Identity',                   hypermove: 'ERC-8004 KYA + Phala TEE attestation',            status: 'shipped' },
  { n: 6,  ios: 'Push notifications',         hypermove: 'HyperMove Push (WebSocket/SSE event bus)',        status: 'q4', note: 'HM7' },
  { n: 7,  ios: 'Storage (iCloud + local)',   hypermove: 'HyperMove Memory tier (IPFS/Walrus/S3)',          status: 'q4', note: 'HM6' },
  { n: 8,  ios: 'Security (Secure Enclave)',  hypermove: 'Phala TEE + policy engine + agentjacking guard',  status: 'v2', note: 'HM4' },
  { n: 9,  ios: 'Observability (Instruments)',hypermove: 'wrapAgentEndpoint + /portal/telemetry',           status: 'v2', note: 'HM1+HM3' },
  { n: 10, ios: 'Developer tools',            hypermove: 'hypermove.dev/portal + docs + scanner',           status: 'shipped' },
  { n: 11, ios: 'Runtime (executes apps)',    hypermove: 'WebMCP runtime + managed hosted MCP',             status: 'q1', note: 'HM8' },
  { n: 12, ios: 'Update mechanism (OTA)',     hypermove: 'HyperMove Update Manager (versioning + rollback)', status: 'q1', note: 'HM9' },
];

const BADGE: Record<Primitive['status'], { label: string; className: string }> = {
  shipped: { label: 'shipped',       className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  v2:      { label: 'v2.0 (this sprint)', className: 'bg-sky-500/10 text-sky-300 border-sky-500/20' },
  q4:      { label: 'Q4 2026',       className: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
  q1:      { label: 'Q1 2027',       className: 'bg-violet-500/10 text-violet-300 border-violet-500/20' },
};

export default function RoadmapPage() {
  const shipped = PRIMITIVES.filter((p) => p.status === 'shipped').length;
  const v2 = PRIMITIVES.filter((p) => p.status === 'v2').length;
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <header className="mb-10">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">HyperMove roadmap</p>
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-100">iOS for AI agents</h1>
        <p className="mt-3 max-w-2xl text-sm text-neutral-400">
          Apple iOS ships 12 platform primitives for apps. HyperMove ships the equivalents for AI agents.
          Today {shipped}/12 are live and {v2} more land in v2.0 this sprint.
        </p>
      </header>

      <div className="overflow-hidden rounded-xl border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900/60 text-xs uppercase tracking-wider text-neutral-400">
            <tr>
              <th className="w-10 px-4 py-3 text-left">#</th>
              <th className="px-4 py-3 text-left">iOS primitive</th>
              <th className="px-4 py-3 text-left">HyperMove analog</th>
              <th className="px-4 py-3 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/70">
            {PRIMITIVES.map((p) => {
              const b = BADGE[p.status];
              return (
                <tr key={p.n} className="hover:bg-neutral-900/30">
                  <td className="px-4 py-3 text-neutral-500">{p.n}</td>
                  <td className="px-4 py-3 text-neutral-200">{p.ios}</td>
                  <td className="px-4 py-3 text-neutral-300">
                    {p.hypermove}
                    {p.note && <span className="ml-2 text-xs text-neutral-500">· {p.note}</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={`inline-block rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider ${b.className}`}>
                      {b.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <section className="mt-10 text-sm text-neutral-400">
        <h2 className="mb-2 text-base font-semibold text-neutral-200">v2.0 sprint (this cycle)</h2>
        <p>
          HM1 error handler + HM2 sentinel + HM3 telemetry dashboard + HM4 agentjacking defense.
          All four ship behind a single master flag <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs text-neutral-200">FEATURE_HM_PLATFORM</code>.
          {' '}Rollback is a single env-var flip.
        </p>
      </section>
    </main>
  );
}
