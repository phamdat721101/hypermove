import Link from 'next/link';
import { BOOK_DEMO_URL } from '@/lib/nav-config';

interface HeroProps {
  /** Right-hand panel (live agent demo, or static placeholder during S1). */
  demoSlot: React.ReactNode;
}

export default function Hero({ demoSlot }: HeroProps) {
  return (
    <section className="mx-auto grid max-w-container grid-cols-1 items-center gap-gutter px-margin-mobile py-12 md:grid-cols-12 md:px-margin-desktop md:py-20">
      <div className="flex flex-col gap-6 md:col-span-6">
        <span className="chip w-fit border border-outline-variant/40 bg-surface-container-high/50 text-on-surface-variant">
          <span className="text-secondary" aria-hidden="true">●</span>
          n-payment v0.29.1 · open-source · MIT
        </span>

        <h1 className="text-display-lg-mobile font-bold tracking-tight text-on-surface md:text-display-lg">
          Make any web3 dApp <br />
          agent-callable in{' '}
          <span className="gradient-text-purple-cyan">3 lines of HTML.</span>
        </h1>

        <p className="max-w-xl text-body-base text-on-surface-variant">
          <code className="font-mono text-secondary">hypermove.dev</code> is the single destination where any web3 dApp
          becomes agent-callable and starts earning USDC per agent call in five minutes. The homepage IS the demo —
          watch an AI agent pay the page $0.01 in real time.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Link href="/portal" className="btn-primary">Start free →</Link>
          <Link href="/docs/quickstart" className="btn-ghost">Read docs</Link>
          <a href={BOOK_DEMO_URL} target="_blank" rel="noreferrer" className="btn-ghost">
            Book a demo
          </a>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-4 border-t border-outline-variant/20 pt-6">
          <Stat value="27" label="chains" />
          <Stat value="14" label="payment protocols" />
          <Stat value="5 min" label="to first paid call" />
        </dl>
      </div>

      <div className="md:col-span-6">{demoSlot}</div>
    </section>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dt className="text-label-mono uppercase tracking-wider text-on-surface-variant">{label}</dt>
      <dd className="font-mono text-headline-md text-secondary">{value}</dd>
    </div>
  );
}
