'use client';

import { useState, useRef, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';

/** Minimal clipboard button. Copies `text` prop directly. */
export default function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="inline-flex items-center rounded-lg bg-hm-purple px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-hm-purple/90"
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

/** Code block copy button — copies text content from sibling <pre> element. */
export function CodeCopyButton() {
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleCopy = useCallback(() => {
    const pre = btnRef.current?.parentElement?.querySelector('pre');
    if (!pre) return;
    void navigator.clipboard.writeText(pre.textContent || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <button
      ref={btnRef}
      onClick={handleCopy}
      className="absolute top-3 right-3 flex items-center gap-1 px-2 py-1 text-[11px] text-gray-400"
      title="Copy code"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}


