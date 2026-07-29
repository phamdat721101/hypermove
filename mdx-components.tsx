import type { MDXComponents } from 'mdx/types';
import type { ComponentPropsWithoutRef } from 'react';

// rehype-pretty-code wraps fenced code blocks as <pre><code data-language="...">
// with Shiki's own per-token inline `style="color:..."` spans already baked
// in — the `code` override below must NOT re-apply the inline-code pill
// styling (background/padding/color) to that case, or it visually fights
// Shiki's colors and wraps the whole block in an incorrect pill shape.
// Inline code (`foo`) has no `data-language` attribute, so that's the signal
// used to tell the two apart.
function isFencedCode(props: ComponentPropsWithoutRef<'code'>): boolean {
  return 'data-language' in props || 'dataLanguage' in props;
}

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children }) => <h1 className="font-heading text-2xl font-bold text-hm-primary mb-2">{children}</h1>,
    h2: ({ children }) => <h2 className="font-heading text-lg font-bold text-hm-primary mt-8 mb-2">{children}</h2>,
    h3: ({ children }) => <h3 className="font-heading text-base font-semibold text-hm-primary mt-6 mb-2">{children}</h3>,
    p: ({ children }) => <p className="text-sm text-hm-dark mb-3 leading-relaxed">{children}</p>,
    a: ({ href, children }) => <a href={href} className="text-hm-purple hover:text-hm-purple/80">{children}</a>,
    code: (props) => {
      const { children, className } = props;
      if (isFencedCode(props)) {
        // Thin structural wrapper only — let Shiki's own inline token colors
        // render unmodified. `className` carries rehype-pretty-code's own
        // classes (e.g. language markers); pass it through untouched.
        return <code className={className}>{children}</code>;
      }
      return <code className="font-mono text-hm-purple bg-hm-muted px-1.5 py-0.5 rounded text-[11px]">{children}</code>;
    },
    // rehype-pretty-code renders its own <pre> (via `keepBackground: false`,
    // the code's background comes from this wrapper, not Shiki's theme) —
    // this stays a thin structural shell so Shiki's per-token colors are the
    // only source of syntax color, avoiding the text-color/background clash
    // a heavier override would cause.
    pre: ({ children, ...rest }) => (
      <div className="relative mb-4">
        <pre className="rounded-xl bg-[#f5f5f7] p-4 font-mono text-[11px] overflow-x-auto" {...rest}>
          {children}
        </pre>
      </div>
    ),
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
