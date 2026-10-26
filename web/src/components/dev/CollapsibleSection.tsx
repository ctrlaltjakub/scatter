'use client';
import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { AnimatedCollapse } from '../AnimatedCollapse';

/** A header that toggles its content open/closed, collapsed by default. Used to
 *  keep the dev options (and each prompt) compact until expanded. */
export function CollapsibleSection({
  title,
  defaultOpen = false,
  right,
  description,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  /** Optional control rendered at the right edge of the header (e.g. a copy button). */
  right?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div style={{ borderBottom: '1px solid var(--ui-line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={title}
          aria-controls={`${id}-content`}
          aria-describedby={description ? `${id}-description` : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: 1,
            minWidth: 0,
            background: 'none',
            border: 'none',
            padding: '9px 0',
            cursor: 'var(--cur-click)',
            color: 'var(--text)',
            fontWeight: 600,
            fontSize: 13,
            textAlign: 'left',
          }}
        >
          <ChevronRight
            size={14}
            className="sc-collapse-chevron"
            style={{
              transform: open ? 'rotate(90deg)' : 'none',
              flexShrink: 0,
            }}
          />
          <span style={{ minWidth: 0 }}>
            <span
              style={{ display: 'block', overflowWrap: 'anywhere' }}
            >
              {title}
            </span>
            {description && (
              <small
                id={`${id}-description`}
                style={{
                  display: 'block',
                  marginTop: 4,
                  fontSize: 12,
                  fontWeight: 400,
                  color: 'var(--subtext0)',
                  lineHeight: 1.5,
                }}
              >
                {description}
              </small>
            )}
          </span>
        </button>
        {right}
      </div>
      <AnimatedCollapse open={open} id={`${id}-content`}>
        <div style={{ paddingBottom: 12 }}>
          {children}
        </div>
      </AnimatedCollapse>
    </div>
  );
}
