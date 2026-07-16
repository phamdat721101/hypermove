import type { MDXComponents } from 'mdx/types';
import { CodeCopyButton } from '@/components/CopyButton';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children }) => (
      <h1 className="font-heading text-3xl font-bold text-hm-primary mb-4 pb-3 border-b border-hm-accent">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="font-heading text-xl font-bold text-hm-primary mt-12 mb-4 pb-2 border-b border-hm-accent/50">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-heading text-base font-semibold text-hm-primary mt-8 mb-3">{children}</h3>
    ),
    p: ({ children }) => (
      <p className="text-[15px] text-hm-dark mb-4 leading-[1.75]">{children}</p>
    ),
    a: ({ href, children }) => (
      <a href={href} className="text-hm-purple font-medium underline decoration-hm-purple/30 underline-offset-2 hover:decoration-hm-purple transition-colors">{children}</a>
    ),
    code: ({ children }) => (
      <code className="font-mono text-[13px] text-hm-purple bg-hm-purple/5 border border-hm-purple/10 px-1.5 py-0.5 rounded-md">{children}</code>
    ),
    pre: ({ children }) => (
      <div className="relative mb-6 group">
        <CodeCopyButton />
        <pre className="rounded-xl bg-[#1a1a2e] p-5 font-mono text-[13px] text-gray-300 overflow-x-auto leading-relaxed border border-[#2a2a3e]">{children}</pre>
      </div>
    ),
    ul: ({ children }) => (
      <ul className="mb-5 space-y-2 pl-0">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-6 text-[15px] text-hm-dark space-y-2 mb-5 leading-[1.75]">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="text-[15px] text-hm-dark leading-[1.75] pl-1 relative before:content-[''] before:absolute before:left-[-16px] before:top-[11px] before:h-1.5 before:w-1.5 before:rounded-full before:bg-hm-purple/40 ml-4">{children}</li>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-3 border-hm-purple/40 bg-hm-purple/[0.03] rounded-r-lg pl-5 pr-4 py-4 text-[15px] text-hm-dark/80 italic mb-6 [&>p]:mb-0">{children}</blockquote>
    ),
    strong: ({ children }) => (
      <strong className="text-hm-primary font-semibold">{children}</strong>
    ),
    em: ({ children }) => (
      <em className="text-hm-dark/70 not-italic">{children}</em>
    ),
    hr: () => (
      <hr className="my-10 border-hm-accent" />
    ),
    table: ({ children }) => (
      <div className="overflow-x-auto mb-6 rounded-xl border border-hm-accent">
        <table className="w-full text-sm text-hm-dark">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-hm-bg border-b border-hm-accent">{children}</thead>
    ),
    th: ({ children }) => (
      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-hm-grey">{children}</th>
    ),
    td: ({ children }) => (
      <td className="px-4 py-3 border-t border-hm-accent">{children}</td>
    ),
    ...components,
  };
}
