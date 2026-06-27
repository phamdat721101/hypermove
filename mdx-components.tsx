import type { MDXComponents } from 'mdx/types';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children }) => <h1 className="font-display text-2xl font-bold text-white mb-2">{children}</h1>,
    h2: ({ children }) => <h2 className="font-display text-lg font-bold text-white mt-8 mb-2">{children}</h2>,
    h3: ({ children }) => <h3 className="font-display text-base font-semibold text-white mt-6 mb-2">{children}</h3>,
    p: ({ children }) => <p className="text-sm text-gray-400 mb-3 leading-relaxed">{children}</p>,
    a: ({ href, children }) => <a href={href} className="text-indigo-400 hover:text-indigo-300">{children}</a>,
    code: ({ children }) => <code className="font-mono text-indigo-400 bg-gray-800/50 px-1 py-0.5 rounded text-[11px]">{children}</code>,
    pre: ({ children }) => <div className="relative mb-4"><pre className="rounded-lg bg-black/80 border border-gray-800 p-3.5 font-mono text-[11px] text-gray-300 overflow-x-auto">{children}</pre></div>,
    ul: ({ children }) => <ul className="list-disc pl-5 text-sm text-gray-400 space-y-1 mb-4">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 text-sm text-gray-400 space-y-1 mb-4">{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    blockquote: ({ children }) => <blockquote className="border-l-2 border-indigo-500 pl-4 text-sm text-gray-500 italic mb-4">{children}</blockquote>,
    strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
    table: ({ children }) => <div className="overflow-x-auto mb-4"><table className="w-full text-xs text-gray-400 border-collapse">{children}</table></div>,
    th: ({ children }) => <th className="border border-gray-800 px-3 py-2 text-left text-white font-medium bg-gray-900/50">{children}</th>,
    td: ({ children }) => <td className="border border-gray-800 px-3 py-2">{children}</td>,
    ...components,
  };
}
