'use client';
import { memo, useState, Children, isValidElement, useMemo } from 'react';
import type { ReactNode, ReactElement, MouseEvent as ReactMouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight } from 'lucide-react';
import { ReferenceChip } from '@/components/node/ReferenceChip';

interface Props { body: string; parentNodeId: string; onReferenceClick: (term: string, opts: { withModifier: boolean }) => void; }

const REF_RE = /(?<!\[)\[\[([^\[\]]+?)\]\](?!\])/g;

function rewriteWikiLinks(md: string): string {
  return md.replace(REF_RE, (_full, term) => {
    const t = term.trim();
    if (!t) return _full;
    return `[${t}](#wiki/${encodeURIComponent(t)})`;
  });
}

/** Detect if a markdown <li>'s children include a nested list. The
 *  unified AST node (`node`) from react-markdown carries `position`
 *  info; we use start-line/column as a stable key so collapse state
 *  survives re-renders (e.g. during streaming). */
function liNestedListPos(node: unknown): string | null {
  if (typeof node !== 'object' || node === null) return null;
  const n = node as { children?: { type?: string; tagName?: string }[]; position?: { start?: { line?: number; column?: number } } };
  if (!Array.isArray(n.children)) return null;
  const hasNested = n.children.some((c) => c?.tagName === 'ul' || c?.tagName === 'ol' || c?.type === 'list');
  if (!hasNested) return null;
  const p = n.position?.start;
  if (!p) return null;
  return `${p.line ?? 0}:${p.column ?? 0}`;
}

function isListElement(child: ReactNode): boolean {
  if (!isValidElement(child)) return false;
  const t = (child as ReactElement).type;
  return t === 'ul' || t === 'ol';
}

function MarkdownViewInner({ body, parentNodeId, onReferenceClick }: Props) {
  const rewritten = useMemo(() => rewriteWikiLinks(body), [body]);
  // Set of EXPANDED list-item position keys. Default = empty = all
  // collapsed (so freshly-rendered node bodies show only top-level
  // bullets; the user opens what they want).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  return (
    <div className="prose prose-sm max-w-none text-ctp-text sc-collapsible-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...rest }) => {
            if (typeof href === 'string' && href.startsWith('#wiki/')) {
              const term = decodeURIComponent(href.slice('#wiki/'.length));
              return <ReferenceChip term={term} parentNodeId={parentNodeId} onClick={onReferenceClick} />;
            }
            return <a href={href} {...rest}>{children}</a>;
          },
          li: ({ children, node, ...rest }) => {
            const posKey = liNestedListPos(node);
            if (!posKey) return <li {...rest}>{children}</li>;
            // Split children into "head" (text/inline) and "nested" (the list).
            const headParts: ReactNode[] = [];
            const tailParts: ReactNode[] = [];
            Children.forEach(children, (c) => {
              if (isListElement(c)) tailParts.push(c);
              else headParts.push(c);
            });
            const isPinned = expanded.has(posKey);
            const toggle = (e: ReactMouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(posKey)) next.delete(posKey); else next.add(posKey);
                return next;
              });
            };
            const headClick = (e: ReactMouseEvent) => {
              // Don't toggle (pin) if the user clicked an interactive
              // child. ReferenceChip stops propagation itself;
              // closest() catches plain <a> links and other buttons.
              const t = e.target as HTMLElement;
              if (t.closest('a, button')) return;
              toggle(e);
            };
            return (
              <li
                {...rest}
                className={`sc-collapsible-li${isPinned ? ' is-pinned' : ''}`}
              >
                <button
                  type="button"
                  className="sc-collapsible-toggle"
                  onClick={toggle}
                  aria-expanded={isPinned}
                  aria-label={isPinned ? 'Unpin (collapse on mouse leave)' : 'Pin open'}
                  data-tip={isPinned ? 'Unpin' : 'Pin open'}
                >
                  <ChevronRight size={12} className="sc-collapsible-chev" />
                </button>
                <span
                  className="sc-collapsible-head"
                  data-tip={isPinned ? 'Unpin' : 'Pin open'}
                  onClick={headClick}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle(e as unknown as ReactMouseEvent);
                    }
                  }}
                >
                  {headParts}
                </span>
                {tailParts}
              </li>
            );
          },
        }}
      >
        {rewritten}
      </ReactMarkdown>
    </div>
  );
}

// Memo: only re-render when body or onReferenceClick reference changes.
// NodeBody passes a stabilized onReferenceClick via useCallback+ref, so this
// effectively re-renders only when body changes (i.e., during streaming).
export const MarkdownView = memo(MarkdownViewInner);
