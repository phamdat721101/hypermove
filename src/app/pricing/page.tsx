import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Free 3-lifetime · Pro $5 USDC/mo · Mode B 90/10 split. No Stripe, no credit card.',
};

interface Tier {
  name: string;
  price: string;
  cadence: string;
  description: string;
  features: readonly string[];
  cta: { label: string; href: string };
  highlight?: boolean;
}

const TIERS: readonly Tier[] = [
  {
    name: 'Free',
    price: '$0',
    cadence: '3 paid MCPs for life',
    description: 'For prototyping and personal projects. Self-host the 4-file bundle anywhere.',
    features: [
      'Up to 3 paid MCPs total',
      'Mode A self-host (4-file ZIP)',
      'All 27 chains · all 14 protocols',
      'Community Discord support',
      '100% revenue retained',
    ],
    cta: { label: 'Start free', href: '/portal' },
  },
  {
    name: 'Pro',
    price: '$5',
    cadence: 'USDC / month, cancel anytime',
    description: 'For teams shipping paid MCPs across multiple dApps and chains.',
    features: [
      'Unlimited Mode A MCPs',
      'Aave V3 GHO treasury (idle USDC yield)',
      'Per-tool override pricing',
      'Email + DM support',
      '100% revenue retained',
    ],
    cta: { label: 'Upgrade with USDC', href: '/portal?plan=pro' },
    highlight: true,
  },
  {
    name: 'Mode B Hosted',
    price: '90 / 10',
    cadence: 'split, S3+',
    description: 'One-line `<script>` install. We host the MCP proxy at hypermove.dev.',
    features: [
      '1-line <script> install',
      'Hosted at hypermove.dev/h/<your-domain>',
      'ed25519 DNS-TXT signature',
      'Weekly USDC payout',
      '90% revenue to you · 10% to hypermove.dev',
    ],
    cta: { label: 'Join waitlist', href: '/registry' },
  },
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-container px-margin-mobile py-16 md:px-margin-desktop md:py-24">
      <header className="mb-12 max-w-2xl">
        <span className="chip border border-outline-variant/40 bg-surface-container-high/40 text-on-surface-variant">
          USDC only · No Stripe · No credit card
        </span>
        <h1 className="mt-4 text-display-lg-mobile font-bold tracking-tight text-on-surface md:text-display-lg">
          Pricing built for <span className="gradient-text-purple-cyan">agent payments</span>.
        </h1>
        <p className="mt-4 text-body-base text-on-surface-variant">
          Every plan settles in USDC on-chain. Pay with the same wallet your agent uses. No KYC, no chargebacks.
        </p>
      </header>

      <ul className="grid gap-gutter md:grid-cols-3">
        {TIERS.map((tier) => (
          <li
            key={tier.name}
            className={`glass-panel relative flex flex-col gap-6 rounded-lg p-6 ${
              tier.highlight ? 'border-primary-container/60 shadow-neon-purple' : ''
            }`}
          >
            {tier.highlight && (
              <span className="chip absolute -top-3 left-6 border border-primary-container bg-background text-primary">
                Most popular
              </span>
            )}
            <div>
              <h2 className="text-headline-md font-semibold text-on-surface">{tier.name}</h2>
              <p className="mt-1 text-body-sm text-on-surface-variant">{tier.description}</p>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-display-lg-mobile font-bold text-on-surface">
                {tier.price}
              </span>
              <span className="text-body-sm text-on-surface-variant">{tier.cadence}</span>
            </div>
            <ul className="flex flex-col gap-2 text-body-sm text-on-surface-variant">
              {tier.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <span aria-hidden="true" className="mt-1 text-tertiary">✓</span>
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <Link href={tier.cta.href} className={tier.highlight ? 'btn-primary' : 'btn-ghost'}>
              {tier.cta.label}
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-10 max-w-2xl text-body-sm text-on-surface-variant">
        <strong className="text-on-surface">No Stripe.</strong> Every payment is an on-chain USDC transfer settled through the
        same n-payment SDK your dApp uses. Receipts are EIP-3009 authorize signatures recorded in the
        <code className="ml-1 font-mono text-secondary">/dashboard</code> ledger.
      </p>
    </div>
  );
}
