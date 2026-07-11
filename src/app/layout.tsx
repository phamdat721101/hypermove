import type { Metadata } from 'next';
import { Globe, MessageCircle } from 'lucide-react';
import Navbar from '@/components/Navbar';
import Web3Provider from '@/components/Web3Provider';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://hypermove.xyz'),
  title: {
    default: 'HyperMove — Turn any dApp into an AI-agent MCP server',
    template: '%s · HyperMove',
  },
  description: 'Paste a URL → AI analyzes → get MCP server config for Claude, Cursor, Kiro. No coding needed.',
  icons: { icon: '/favicon.png', apple: '/favicon.png' },
  openGraph: {
    title: 'HyperMove — Turn any dApp into an AI-agent MCP server',
    description: 'Paste a URL → AI analyzes → get MCP server config. No coding needed.',
    url: 'https://hypermove.xyz',
    siteName: 'HyperMove',
    type: 'website',
  },
  twitter: { card: 'summary_large_image', creator: '@phamdat721101' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col bg-white text-hm-dark">
        <Web3Provider>
          <div className="relative">
            <Navbar />
            <main className="flex-1">{children}</main>
          </div>
          <Footer />
        </Web3Provider>
      </body>
    </html>
  );
}

function Footer() {
  return (
    <footer className="bg-hm-bg py-16">
      <div className="section-container">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div>
            <img src="/logo-black.png" alt="HyperMove" className="h-10 w-10 rounded-lg mb-4" />
            <div className="flex items-center gap-2 text-sm text-hm-dark/70 mb-2">
              <Globe className="h-4 w-4" />
              <a href="#" className="hover:text-hm-purple">Global</a>
            </div>
            <div className="flex items-center gap-2 text-sm text-hm-dark/70">
              <MessageCircle className="h-4 w-4" />
              <a href="#" className="hover:text-hm-purple">English</a>
            </div>
          </div>
          <div>
            <h3 className="font-heading text-lg font-bold mb-4">Products</h3>
            <ul className="space-y-3 text-sm text-hm-dark/70">
              <li><a href="/portal/generate" className="hover:text-hm-purple">MCP Generator</a></li>
              <li><a href="/portal" className="hover:text-hm-purple">Portal Catalog</a></li>
              <li><a href="/pricing" className="hover:text-hm-purple">Pricing</a></li>
              <li><a href="/docs/quickstart" className="hover:text-hm-purple">API Docs</a></li>
            </ul>
          </div>
          <div>
            <h3 className="font-heading text-lg font-bold mb-4">Contact Us</h3>
            <ul className="space-y-3 text-sm text-hm-dark/70">
              <li><a href="https://calendly.com/phamdat721101/30min" target="_blank" rel="noreferrer" className="hover:text-hm-purple">Book a Demo</a></li>
              <li><a href="mailto:phamdat721101@gmail.com" className="hover:text-hm-purple">Email us</a></li>
            </ul>
          </div>
          <div>
            <h3 className="font-heading text-lg font-bold mb-4">Resources</h3>
            <ul className="space-y-3 text-sm text-hm-dark/70">
              <li><a href="https://github.com/phamdat721101" target="_blank" rel="noreferrer" className="hover:text-hm-purple">GitHub</a></li>
              <li><a href="https://www.npmjs.com/package/n-payment" target="_blank" rel="noreferrer" className="hover:text-hm-purple">npm</a></li>
              <li><a href="/docs/quickstart" className="hover:text-hm-purple">Guides</a></li>
              <li><a href="#" className="hover:text-hm-purple">Privacy & Terms</a></li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
}
