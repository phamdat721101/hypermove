'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount, useDisconnect } from 'wagmi';
import { useState, useEffect } from 'react';
import { LogOut } from 'lucide-react';

const navItems = [
  { href: '/', label: 'Products' },
  { href: '/portal', label: 'Portal' },
  { href: '/docs/quickstart', label: 'Developers' },
  { href: '/pricing', label: 'Pricing' },
];

export default function Navbar() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const isHome = pathname === '/';

  return (
    <nav className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between w-full max-w-[1144px] mx-auto px-6 py-5">
      <Link href="/" className="flex items-center gap-2">
        <img src="/logo-black.png" alt="HyperMove" className="h-9 w-9 rounded-md" />
        <span className="font-heading text-xl font-bold text-hm-primary">HyperMove</span>
      </Link>

      <ul className="hidden md:flex items-center gap-8">
        {navItems.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className={`text-base font-bold transition-colors ${
                isHome
                  ? (pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))
                    ? 'text-white'
                    : 'text-white/80 hover:text-white hover:underline')
                  : (pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))
                    ? 'text-hm-purple'
                    : 'text-hm-dark hover:text-hm-purple hover:underline')
              }`}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-3">
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
            href="/portal"
            className={`rounded-full px-5 py-2 text-sm font-bold transition-colors ${isHome ? 'bg-white/20 hover:bg-white/30 backdrop-blur-sm text-white' : 'bg-hm-purple hover:bg-hm-purple/90 text-white'}`}
          >
            Start For Free
          </Link>
        )}
      </div>
    </nav>
  );
}
