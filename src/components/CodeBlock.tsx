'use client';

import { useState } from 'react';

interface CodeBlockProps {
  /** Plain text code. Prefer template literals over MDX fenced blocks for typed snippets. */
  code: string;
  language?: 'ts' | 'tsx' | 'bash' | 'html' | 'json';
  /** Optional caption rendered above the block. */
  caption?: string;
  /** Render full-width inside a glassmorphic frame. Default true. */
  framed?: boolean;
}

const LANG_LABEL: Record<NonNullable<CodeBlockProps['language']>, string> = {
  ts: 'typescript',
  tsx: 'typescript / jsx',
  bash: 'bash',
  html: 'html',
  json: 'json',
};

export default function CodeBlock({ code, language = 'ts', caption, framed = true }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. older browsers, http) — fall back silently.
    }
  };

  const body = (
    <pre className="overflow-x-auto scrollbar-thin px-4 py-3 text-code-block font-mono leading-relaxed text-on-surface">
      <code>{code}</code>
    </pre>
  );

  return (
    <figure className={framed ? 'terminal-frame my-4' : 'my-2'}>
      <header className="flex items-center justify-between border-b border-outline-variant/30 bg-surface-container-lowest/60 px-3 py-2">
        <span className="text-label-mono uppercase tracking-wider text-on-surface-variant">
          {caption ?? LANG_LABEL[language]}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="text-label-mono uppercase tracking-wider text-secondary hover:text-primary transition-colors"
          aria-label="Copy code"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </header>
      <div className="bg-black/40">{body}</div>
    </figure>
  );
}
