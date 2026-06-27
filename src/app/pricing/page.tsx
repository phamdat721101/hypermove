import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Free 3-lifetime · Pro $5 USDC/mo · Mode B 90/10 split. No Stripe, no credit card.',
};

const TIERS = [
  {
    name: 'Free',
    price: '$0',
    cadence: '3 paid MCPs for life',
    description: 'For prototyping and personal projects. Self-host the 4-file bundle anywhere.',
    features: ['Up to 3 paid MCPs total', 'Mode A self-host (4-file ZIP)', 'All 27 chains · all 14 protocols', 'Community Discord support', '100% revenue retained'],
    cta: { label: 'Start free', href: '/portal' },
  },
  {
    name: 'Pro',
    price: '$5',
    cadence: 'USDC / month',
    description: 'For teams shipping paid MCPs across multiple dApps and chains.',
    features: ['Unlimited Mode A MCPs', 'Aave V3 GHO treasury (idle USDC yield)', 'Per-tool override pricing', 'Email + DM support', '100% revenue retained'],
    cta: { label: 'Upgrade with USDC', href: '/portal?plan=pro' },
    highlight: true,
  },
  {
    name: 'Mode B Hosted',
    price: '90/10',
    cadence: 'split',
    description: 'One-line <script> install. We host the MCP proxy at hypermove.dev.',
    features: ['1-line <script> install', 'Hosted at hypermove.dev/h/<domain>', 'ed25519 DNS-TXT signature', 'Weekly USDC payout', '90% to you · 10% infra'],
    cta: { label: 'Join waitlist', href: '/registry' },
  },
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mb-12">
        <span className="inline-block rounded-full border border-gray-700 bg-gray-800/50 px-3 py-1 text-xs font-mono text-gray-400 uppercase tracking-wider">
          USDC only · No Stripe · No credit card
        </span>
        <h1 className="mt-4 font-display text-4xl font-bold text-white sm:text-5xl">
          Pricing built for <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">agent payments</span>.
        </h1>
        <p className="mt-4 max-w-2xl text-gray-400">
          Every plan settles in USDC on-chain. Pay with the same wallet your agent uses. No KYC, no chargebacks.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {TIERS.map((tier) => (
          <div key={tier.name} className={`relative flex flex-col gap-6 rounded-xl border p-6 ${tier.highlight ? 'border-indigo-500/50 bg-indigo-500/5 shadow-lg shadow-indigo-500/10' : 'border-gray-800 bg-gray-900/40'}`}>
            {tier.highlight && (
              <span className="absolute -top-3 left-6 rounded-full bg-indigo-600 px-3 py-0.5 text-xs font-medium text-white">
                Most popular
              </span>
            )}
            <div>
              <h2 className="font-display text-xl font-semibold text-white">{tier.name}</h2>
              <p className="mt-1 text-sm text-gray-500">{tier.description}</p>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-4xl font-bold text-white">{tier.price}</span>
              <span className="text-sm text-gray-500">{tier.cadence}</span>
            </div>
            <ul className="flex flex-col gap-2 text-sm text-gray-400">
              {tier.features.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span className="text-green-400 mt-0.5">✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link href={tier.cta.href} className={`mt-auto rounded-lg px-4 py-2.5 text-center text-sm font-medium transition-colors ${tier.highlight ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500'}`}>
              {tier.cta.label}
            </Link>
          </div>
        ))}
      </div>

      <p className="mt-10 max-w-2xl text-sm text-gray-500">
        <strong className="text-white">No Stripe.</strong> Every payment is an on-chain USDC transfer settled through the same n-payment SDK your dApp uses.
      </p>
    </div>
  );
}
