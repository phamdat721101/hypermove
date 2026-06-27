'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, Zap, BookOpen, CreditCard } from 'lucide-react';

const navItems = [
  { href: '/', label: 'Product', icon: Zap },
  { href: '/portal', label: 'Portal', icon: LayoutGrid },
  { href: '/docs/quickstart', label: 'Docs', icon: BookOpen },
  { href: '/pricing', label: 'Pricing', icon: CreditCard },
];

export default function Navbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-gray-800/80 bg-gray-950/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center space-x-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 font-display text-lg font-bold text-white shadow-lg shadow-indigo-500/25">
            H
          </div>
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

        <Link
          href="/portal/generate"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-md shadow-indigo-500/20 hover:bg-indigo-500 transition-colors"
        >
          Start For Free
        </Link>
      </div>
    </header>
  );
}
