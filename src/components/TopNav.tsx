'use client';

import Link from 'next/link';
import Image from 'next/image';
import { TOP_NAV } from '@/lib/nav-config';

export default function TopNav() {
  return (
    <header className="fixed top-0 z-50 w-full border-b border-outline-variant/30 bg-background/80 backdrop-blur-glass shadow-neon-purple/30">
      <div className="mx-auto flex max-w-container items-center justify-between px-margin-mobile py-4 md:px-margin-desktop">
        <Link href="/" aria-label="HyperMove home" className="flex items-center gap-3">
          <Image
            src="/logo.png"
            alt="HyperMove logo"
            width={36}
            height={36}
            priority
            className="h-9 w-9 rounded-md bg-white p-0.5 shadow-neon-purple/40"
          />
          <span className="text-display-lg-mobile font-bold tracking-tighter text-primary">
            HyperMove
          </span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {TOP_NAV.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group inline-flex items-center gap-2 text-body-base text-on-surface-variant transition-colors hover:text-primary"
            >
              {link.label}
              {link.soon && (
                <span className="chip border border-outline-variant/40 bg-surface-container-high/60 text-[10px] text-on-surface-variant">
                  S3
                </span>
              )}
            </Link>
          ))}
        </nav>

        <Link href="/portal" className="btn-primary">
          Start free
        </Link>
      </div>
    </header>
  );
}
