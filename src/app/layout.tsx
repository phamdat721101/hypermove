import type { Metadata } from 'next';
import Navbar from '@/components/Navbar';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://hypermove.dev'),
  title: { default: 'HyperMove — Turn any URL into an AI agent tool', template: '%s · HyperMove' },
  description: 'Paste a URL. AI analyzes it. Get an MCP server in seconds. Works with Claude, Cursor, Kiro.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
