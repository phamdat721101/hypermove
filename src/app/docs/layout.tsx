'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Compass, Terminal, ThumbsUp, ThumbsDown } from 'lucide-react';

const nav = [
  { href: '/docs/quickstart', label: 'Quickstart — 5 min', icon: Compass },
  { href: '/docs/n-payment', label: 'n-payment SDK', icon: Terminal },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [helpful, setHelpful] = useState<'none' | 'yes' | 'no'>('none');

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Sidebar */}
        <aside className="lg:col-span-3 rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-1 h-fit sticky top-20">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 mb-2">Docs Outline</p>
          {nav.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            return (
              <Link key={item.href} href={item.href}
                className={`w-full flex items-center space-x-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}`}>
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </aside>

        {/* Content */}
        <main className="lg:col-span-9 rounded-xl border border-gray-800 bg-gray-900/20 p-6 md:p-8">
          {children}

          {/* Feedback */}
          <div className="border-t border-gray-800 pt-6 mt-8">
            <p className="text-xs text-gray-500 mb-2">Was this helpful?</p>
            <div className="flex items-center gap-2">
              <button onClick={() => setHelpful('yes')} className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs transition-colors ${helpful === 'yes' ? 'bg-green-500/10 text-green-400 border border-green-500/30' : 'border border-gray-700 text-gray-400 hover:text-white'}`}>
                <ThumbsUp className="h-3.5 w-3.5" /> Yes
              </button>
              <button onClick={() => setHelpful('no')} className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs transition-colors ${helpful === 'no' ? 'bg-red-500/10 text-red-400 border border-red-500/30' : 'border border-gray-700 text-gray-400 hover:text-white'}`}>
                <ThumbsDown className="h-3.5 w-3.5" /> No
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
