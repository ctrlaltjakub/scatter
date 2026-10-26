'use client';
import { useEffect, useRef } from 'react';
import type { ScatterNode } from '@/store/types';
import { currentContentType, type ContentType } from '@/lib/nodeContentType';
import { retypeNodeToText } from '@/lib/generate';

const LABELS: Record<ContentType, string> = {
  encyclopedic: 'Encyclopedic',
  explain: 'Explain',
  interactive: 'Interactive',
  media: 'Media',
  chat: 'Chat',
  answer: 'Answer',
};
type TextContentType = Extract<ContentType, 'encyclopedic' | 'explain'>;
const ORDER: TextContentType[] = ['encyclopedic', 'explain'];

/**
 * Popover that lets the user change a node's type. Anchored under the footer
 * type tag (see NodeView). Picking a type creates a NEW version in the chosen
 * text format — encyclopedic/explain regenerate from the node's header. Older
 * versions stay in the switcher. The
 * current type is omitted (it would be a no-op). Root nodes never render this.
 */
export function NodeTypeMenu({ node, onClose }: { node: ScatterNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const contentType = currentContentType(node);
  // Interactive is an Explain presentation variant, not a third choice in the
  // footer type menu. Its dedicated side-panel action removes interactivity.
  const current: 'encyclopedic' | 'explain' = contentType === 'encyclopedic'
    ? 'encyclopedic'
    : 'explain';

  // Dismiss on outside pointer-down or Escape.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const pick = (t: TextContentType) => {
    onClose();
    if (t === current) return;
    void retypeNodeToText(node.id, t);
  };

  return (
    <div
      ref={ref}
      className="node-type-menu"
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="node-type-menu-title">Change to:</div>
      {ORDER.filter((t) => t !== current).map((t) => (
        <button
          key={t}
          type="button"
          role="menuitem"
          // Reuse .node-tag so each option looks exactly like the tag just clicked.
          className="node-tag node-type-menu-chip"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); pick(t); }}
        >
          {LABELS[t]}
        </button>
      ))}
    </div>
  );
}
