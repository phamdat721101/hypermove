'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DOCS_NAV } from '@/lib/nav-config';

export default function DocsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Docs sections" className="sticky top-28 self-start">
      <ol className="flex flex-col gap-6">
        {DOCS_NAV.map((section) => (
          <li key={section.title}>
            <h3 className="mb-2 text-label-mono uppercase tracking-wider text-on-surface-variant">
              {section.title}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {section.links.map((link) => {
                const active = pathname === link.href;
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      aria-current={active ? 'page' : undefined}
                      className={`block rounded-md px-3 py-1.5 text-body-sm transition-colors ${
                        active
                          ? 'bg-primary-container/20 text-primary'
                          : 'text-on-surface-variant hover:bg-surface-container-high/50 hover:text-on-surface'
                      }`}
                    >
                      {link.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </nav>
  );
}
