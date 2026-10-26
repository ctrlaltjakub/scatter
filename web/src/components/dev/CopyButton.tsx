'use client';
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/** Small copy-to-clipboard button with a transient "copied" tick. Reused for
 *  per-prompt copy in the dev Prompts editor. */
export function CopyButton({ text, title = 'Copy', label }: { text: string; title?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('[copy] failed', e);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '2px 7px',
        color: copied ? 'var(--green)' : 'var(--subtext1)', background: 'none',
        border: '1px solid var(--ui-line)',
        borderRadius: 'var(--r-sm)', cursor: 'var(--cur-click)',
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {label && (copied ? 'Copied' : label)}
    </button>
  );
}
