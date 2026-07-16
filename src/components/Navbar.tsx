'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount, useDisconnect } from 'wagmi';
import { useState, useEffect } from 'react';
import { LogOut, Menu, X } from 'lucide-react';

const navItems = [
  { href: '/', label: 'Home' },
  { href: '/mcp-connect', label: 'Connect' },
  { href: '/tools', label: 'Tools' },
  { href: '/docs', label: 'Docs' },
];

export default function Navbar() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  const isHome = pathname === '/';

  // Longest-prefix match wins so /tools doesn't stay highlighted on nested routes.
  const activeHref = [...navItems]
    .filter((i) => pathname === i.href || (i.href !== '/' && pathname.startsWith(i.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <nav className="absolute top-0 left-0 right-0 z-50 w-full max-w-[1144px] mx-auto px-6 py-5">
      <div className="flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <img src="/logo-black.png" alt="HyperMove" className="h-9 w-9 rounded-md" />
          <span className="font-heading text-xl font-bold text-hm-primary">HyperMove</span>
        </Link>

        <ul className="hidden md:flex items-center gap-8">
          {navItems.map((item) => {
            const active = item.href === activeHref;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`text-base font-bold transition-colors ${
                    isHome
                      ? (active ? 'text-white' : 'text-white/80 hover:text-white hover:underline')
                      : (active ? 'text-hm-purple' : 'text-hm-dark hover:text-hm-purple hover:underline')
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="hidden md:flex items-center gap-3">
          {mounted && isConnected && address ? (
            <div className="flex items-center gap-2">
              <span className={`text-xs font-mono rounded-full px-3 py-1.5 ${isHome ? 'text-white/80 bg-white/20' : 'text-hm-dark bg-hm-muted'}`}>
                {address.slice(0, 6)}...{address.slice(-4)}
              </span>
              <button onClick={() => disconnect()} className={`flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs transition-colors ${isHome ? 'bg-white/20 text-white/80 hover:text-white hover:bg-white/30' : 'bg-hm-muted text-hm-dark hover:bg-hm-accent'}`}>
                <LogOut className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <Link
              href="/tools"
              className={`rounded-full px-5 py-2 text-sm font-bold transition-colors ${isHome ? 'bg-white/20 hover:bg-white/30 backdrop-blur-sm text-white' : 'bg-hm-purple hover:bg-hm-purple/90 text-white'}`}
            >
              Start For Free
            </Link>
          )}
        </div>

        {/* Mobile hamburger */}
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className={`md:hidden p-2 rounded-lg transition-colors ${isHome ? 'text-white hover:bg-white/20' : 'text-hm-dark hover:bg-hm-muted'}`}
        >
          {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="md:hidden mt-4 rounded-xl bg-white border border-hm-accent shadow-lg p-4 space-y-2">
          {navItems.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-4 py-2.5 rounded-lg text-sm font-bold transition-colors ${
                  active ? 'bg-hm-purple/10 text-hm-purple' : 'text-hm-dark hover:bg-hm-muted'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
          <div className="pt-2 border-t border-hm-accent">
            {mounted && isConnected && address ? (
              <div className="flex items-center justify-between px-4 py-2">
                <span className="text-xs font-mono text-hm-dark">{address.slice(0, 6)}...{address.slice(-4)}</span>
                <button onClick={() => disconnect()} className="text-xs text-hm-grey hover:text-hm-dark">Disconnect</button>
              </div>
            ) : (
              <Link href="/tools" className="block text-center rounded-lg bg-hm-purple px-4 py-2.5 text-sm font-bold text-white">
                Start For Free
              </Link>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
