import type { Metadata } from 'next';
import Link from 'next/link';
import UpgradeButton from '@/components/UpgradeButton';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Free 3-lifetime · Pro $5 USDC/mo · Mode B 90/10 split. No Stripe, no credit card.',
};

const TIERS = [
  {
    name: 'Free',
    price: '$0',
    cadence: '5 free scans',
    description: 'For prototyping and testing. Connect wallet to start.',
    features: ['5 free MCP generations', 'Hosted MCP endpoint', 'All chains supported', 'MCP config for any IDE', 'Community support'],
    cta: { label: 'Start free', href: '/portal/generate' },
  },
  {
    name: 'Pro',
    price: '$5',
    cadence: 'BTC / month',
    description: 'Unlimited scans for teams building with AI agents.',
    features: ['Unlimited MCP generations', 'Hosted MCP endpoint', 'Priority LLM analysis', 'All tools + hosted MCP', 'Email + DM support'],
    cta: { label: 'Upgrade with BTC', href: '/portal?plan=pro' },
    highlight: true,
  },
  {
    name: 'Mode B Hosted',
    price: '90/10',
    cadence: 'split',
    description: 'We host the MCP server for you. One-click deploy.',
    features: ['Auto-hosted MCP server', 'Custom domain support', 'Weekly usage reports', '90% revenue to you · 10% infra', 'Coming soon'],
    cta: { label: 'Join waitlist', href: '/registry' },
  },
];

export default function PricingPage() {
  return (
    <div className="section-container pt-24 pb-16">
      <div className="mb-12">
        <span className="inline-block rounded-full border border-hm-accent bg-hm-muted px-3 py-1 text-xs font-mono text-hm-grey uppercase tracking-wider">
          BTC on GOAT Network · No credit card
        </span>
        <h1 className="mt-4 font-heading text-4xl font-bold text-hm-primary sm:text-5xl">
          Pricing built for <span className="text-hm-purple">agent payments</span>.
        </h1>
        <p className="mt-4 max-w-2xl text-hm-grey">
          Pay with BTC on GOAT Network. Same wallet your agent uses. No KYC, no chargebacks.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {TIERS.map((tier) => (
          <div key={tier.name} className={`relative flex flex-col gap-6 rounded-xl border p-6 ${tier.highlight ? 'border-hm-purple/50 bg-hm-purple/5 shadow-lg shadow-hm-purple/10' : 'border-hm-accent bg-white'}`}>
            {tier.highlight && (
              <span className="absolute -top-3 left-6 rounded-full bg-hm-purple px-3 py-0.5 text-xs font-medium text-white">
                Most popular
              </span>
            )}
            <div>
              <h2 className="font-heading text-xl font-semibold text-hm-primary">{tier.name}</h2>
              <p className="mt-1 text-sm text-hm-grey">{tier.description}</p>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-4xl font-bold text-hm-primary">{tier.price}</span>
              <span className="text-sm text-hm-grey">{tier.cadence}</span>
            </div>
            <ul className="flex flex-col gap-2 text-sm text-hm-grey">
              {tier.features.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span className="text-green-600 mt-0.5">✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            {tier.highlight ? (
              <div className="mt-auto"><UpgradeButton /></div>
            ) : (
              <Link href={tier.cta.href} className="mt-auto rounded-lg px-4 py-2.5 text-center text-sm font-medium transition-colors border border-hm-accent text-hm-dark hover:text-hm-purple hover:border-hm-purple">
                {tier.cta.label}
              </Link>
            )}
          </div>
        ))}
      </div>

      <p className="mt-10 max-w-2xl text-sm text-hm-grey">
        <strong className="text-hm-primary">No Stripe.</strong> Payment is a native BTC transfer on GOAT Network, verified on-chain.
      </p>
    </div>
  );
}
