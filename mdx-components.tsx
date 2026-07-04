import type { MDXComponents } from 'mdx/types';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children }) => <h1 className="font-heading text-2xl font-bold text-hm-primary mb-2">{children}</h1>,
    h2: ({ children }) => <h2 className="font-heading text-lg font-bold text-hm-primary mt-8 mb-2">{children}</h2>,
    h3: ({ children }) => <h3 className="font-heading text-base font-semibold text-hm-primary mt-6 mb-2">{children}</h3>,
    p: ({ children }) => <p className="text-sm text-hm-dark mb-3 leading-relaxed">{children}</p>,
    a: ({ href, children }) => <a href={href} className="text-hm-purple hover:text-hm-purple/80">{children}</a>,
    code: ({ children }) => <code className="font-mono text-hm-purple bg-hm-muted px-1.5 py-0.5 rounded text-[11px]">{children}</code>,
    pre: ({ children }) => <div className="relative mb-4"><pre className="rounded-xl bg-[#f5f5f7] p-4 font-mono text-[11px] text-hm-dark overflow-x-auto">{children}</pre></div>,
    ul: ({ children }) => <ul className="list-disc pl-5 text-sm text-hm-dark space-y-1 mb-4">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 text-sm text-hm-dark space-y-1 mb-4">{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    blockquote: ({ children }) => <blockquote className="border-l-2 border-hm-purple/30 pl-4 text-sm text-hm-grey italic mb-4">{children}</blockquote>,
    strong: ({ children }) => <strong className="text-hm-primary font-semibold">{children}</strong>,
    table: ({ children }) => <div className="overflow-x-auto mb-4"><table className="w-full text-xs text-hm-dark border-collapse">{children}</table></div>,
    th: ({ children }) => <th className="border border-hm-accent px-3 py-2 text-left text-hm-primary font-medium bg-hm-bg">{children}</th>,
    td: ({ children }) => <td className="border border-hm-accent px-3 py-2">{children}</td>,
    ...components,
  };
}
