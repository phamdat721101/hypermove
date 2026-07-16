'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { DOCS_NAV } from '@/lib/nav-config';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [helpful, setHelpful] = useState<'none' | 'yes' | 'no'>('none');

  return (
    <div className="section-container pt-28 pb-16 flex-1">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Sidebar */}
        <aside className="lg:col-span-3 rounded-xl border border-hm-accent bg-white p-4 h-fit sticky top-20 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wider text-hm-grey px-3 mb-3">Documentation</p>
          {DOCS_NAV.map((section) => (
            <div key={section.title} className="mb-3">
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-hm-grey/70">{section.title}</p>
              {section.links.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link key={item.href} href={item.href}
                    className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-hm-purple text-white' : 'text-hm-grey hover:text-hm-dark hover:bg-hm-muted'}`}>
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </aside>

        {/* Content */}
        <main className="lg:col-span-9 rounded-xl border border-hm-accent bg-white p-8 md:p-10 shadow-sm max-w-none">
          {children}

          {/* Feedback */}
          <div className="border-t border-hm-accent pt-6 mt-8">
            <p className="text-xs text-hm-grey mb-2">Was this helpful?</p>
            <div className="flex items-center gap-2">
              <button onClick={() => setHelpful('yes')} className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs transition-colors ${helpful === 'yes' ? 'bg-green-50 text-green-600 border border-green-200' : 'border border-hm-accent text-hm-grey hover:text-hm-dark'}`}>
                <ThumbsUp className="h-3.5 w-3.5" /> Yes
              </button>
              <button onClick={() => setHelpful('no')} className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs transition-colors ${helpful === 'no' ? 'bg-red-50 text-red-600 border border-red-200' : 'border border-hm-accent text-hm-grey hover:text-hm-dark'}`}>
                <ThumbsDown className="h-3.5 w-3.5" /> No
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
