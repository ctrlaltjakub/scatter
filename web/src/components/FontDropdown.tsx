'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronDown } from 'lucide-react';

interface Option {
  id: string;
  label: string;
  sub?: string;
  labelStyle?: CSSProperties;
}

/** The image editor's two-line font menu, also used by node typography settings. */
export function FontDropdown({ value, valueLabel, valueStyle, options, disabled = false, grow, tip, ariaLabel, onPick }: {
  value: string;
  valueLabel: string;
  valueStyle?: CSSProperties;
  options: Option[];
  disabled?: boolean;
  grow?: boolean;
  tip: string;
  ariaLabel: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close, true);
    return () => document.removeEventListener('mousedown', close, true);
  }, [open]);
  return (
    <div ref={rootRef} className={'ie-dd' + (grow ? ' ie-dd--grow' : '')}>
      <button type="button" className="ie-dd-btn" disabled={disabled}
        onClick={() => setOpen((wasOpen) => !wasOpen)} data-tip={tip}
        aria-label={ariaLabel} aria-expanded={open}>
        <span className="ie-dd-value" style={valueStyle}>{valueLabel}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="ie-dd-pop">
          {options.map((option) => (
            <button key={option.id} type="button"
              className={'ie-dd-item' + (option.id === value ? ' sel' : '')}
              aria-current={option.id === value ? 'true' : undefined}
              onClick={() => { onPick(option.id); setOpen(false); }}>
              <span className="ie-dd-item-label" style={option.labelStyle}>{option.label}</span>
              {option.sub && <span className="ie-dd-item-sub">{option.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
