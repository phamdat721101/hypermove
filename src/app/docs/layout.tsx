import DocsNav from '@/components/DocsNav';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto grid max-w-container grid-cols-1 gap-gutter px-margin-mobile py-10 md:grid-cols-12 md:px-margin-desktop">
      <aside className="md:col-span-3">
        <DocsNav />
      </aside>
      <article className="prose prose-invert max-w-none md:col-span-9 prose-headings:font-sans prose-headings:text-on-surface prose-p:text-on-surface-variant prose-strong:text-on-surface prose-a:text-secondary prose-code:rounded prose-code:bg-surface-container-low prose-code:px-1 prose-code:py-0.5 prose-code:text-secondary prose-code:before:hidden prose-code:after:hidden">
        {children}
      </article>
    </div>
  );
}
