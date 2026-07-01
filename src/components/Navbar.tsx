'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, Zap, BookOpen, CreditCard, LogOut } from 'lucide-react';
import { useAccount, useDisconnect } from 'wagmi';
import { useState, useEffect } from 'react';

const navItems = [
  { href: '/', label: 'Product', icon: Zap },
  { href: '/portal', label: 'Portal', icon: LayoutGrid },
  { href: '/docs/quickstart', label: 'Docs', icon: BookOpen },
  { href: '/pricing', label: 'Pricing', icon: CreditCard },
];

export default function Navbar() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-gray-800/80 bg-gray-950/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center space-x-2">
          <img src="/logo.png" alt="HyperMove" width={36} height={36} className="h-9 w-9 rounded-md" />
          <span className="font-display text-xl font-bold tracking-tight text-white">
            HyperMove
          </span>
        </Link>

        <nav className="hidden md:flex items-center space-x-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative flex items-center space-x-1.5 rounded-md px-3.5 py-2 text-sm font-medium transition-colors duration-150 ${
                  isActive ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
                {isActive && (
                  <span className="absolute inset-x-1 -bottom-[17px] h-0.5 bg-indigo-500 rounded-full" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          {mounted && isConnected && address ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-gray-400">
                {address.slice(0, 6)}...{address.slice(-4)}
              </span>
              <button onClick={() => disconnect()} className="flex items-center gap-1 rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors">
                <LogOut className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <Link
              href="/portal"
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-md shadow-indigo-500/20 hover:bg-indigo-500 transition-colors"
            >
              Start For Free
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
