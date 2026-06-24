import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import TopNav from '@/components/TopNav';
import FooterGoatBadge from '@/components/FooterGoatBadge';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL('https://hypermove.dev'),
  title: {
    default: 'HyperMove — Agentic web3, in one <script>',
    template: '%s · HyperMove',
  },
  description:
    'Make any web3 dApp agent-callable in 3 lines of HTML. Monetize in 5 minutes with x402-USDC across 27 chains and 14 protocols. Open-source, MIT-licensed.',
  openGraph: {
    title: 'HyperMove — Agentic web3, in one <script>',
    description: 'n-payment SDK for AI agents that pay. Open-source, MIT-licensed.',
    url: 'https://hypermove.dev',
    siteName: 'HyperMove',
    type: 'website',
  },
  twitter: { card: 'summary_large_image', creator: '@phamdat721101' },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable} dark`}>
      <body className="min-h-screen flex flex-col">
        <TopNav />
        <main id="main" className="flex-1 pt-24">
          {children}
        </main>
        <FooterGoatBadge />
      </body>
    </html>
  );
}
