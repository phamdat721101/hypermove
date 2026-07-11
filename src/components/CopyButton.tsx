'use client';

import { useState } from 'react';

/** Minimal clipboard button. Copies `text`, shows a 2s confirmation. */
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
