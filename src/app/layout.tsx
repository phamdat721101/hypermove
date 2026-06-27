import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import Navbar from '@/components/Navbar';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://hypermove.dev'),
  title: {
    default: 'HyperMove — Agentic web3, in one <script>',
    template: '%s · HyperMove',
  },
  description: 'Make any web3 dApp agent-callable in 3 lines of HTML. Monetize in 5 minutes with x402-USDC across 27 chains and 14 protocols. Open-source, MIT-licensed.',
  openGraph: {
    title: 'HyperMove — Agentic web3, in one <script>',
    description: 'n-payment SDK for AI agents that pay. Open-source, MIT-licensed.',
    url: 'https://hypermove.dev',
    siteName: 'HyperMove',
    type: 'website',
  },
  twitter: { card: 'summary_large_image', creator: '@phamdat721101' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-gray-800 bg-gray-950/80">
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <a href="https://www.npmjs.com/package/n-payment" target="_blank" rel="noreferrer" className="flex items-center space-x-3 rounded-lg bg-gray-800/60 px-4 py-2.5 hover:bg-gray-800 transition-colors">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-xs font-bold text-white">H</div>
              <div>
                <p className="text-xs text-gray-400 uppercase tracking-wider">Open Source · MIT</p>
                <p className="text-sm text-white">n-payment on npm — 27 chains, 14 protocols</p>
              </div>
              <ArrowRight className="h-4 w-4 text-gray-500" />
            </a>
            <nav className="flex items-center gap-6 text-sm text-gray-400">
              <a href="https://www.npmjs.com/package/n-payment" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">npm</a>
              <a href="https://github.com/phamdat721101" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">GitHub</a>
              <a href="https://calendly.com/phamdat721101/30min" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">Book a demo</a>
              <Link href="/docs/quickstart" className="hover:text-white transition-colors">Quickstart</Link>
              <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
              <span className="text-gray-600">V0.1.0 · MIT</span>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
