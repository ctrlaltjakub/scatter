'use client';

import { useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { HeaderParts } from '@/store/types';
import {
  flattenHeaderParts,
  normalizeEditableHeader,
  structuredHeaderPartCount,
} from '@/lib/nodeHeaderText';
import { useGenerationPulseSync } from '@/hooks/useGenerationPulseSync';

type PartKey = keyof HeaderParts;

interface Props {
  value: HeaderParts;
  onChange: (next: HeaderParts) => void;
  constrained?: boolean;
  disabled?: boolean;
  pulsing?: boolean;
  density?: 'regular' | 'compact';
  className?: string;
}

const ORDER: PartKey[] = ['prefix', 'subject', 'question', 'suffix'];
const PART_LABELS: Record<PartKey, string> = {
  prefix: 'PREFIX',
  subject: 'SUBJECT',
  question: 'QUESTION',
  suffix: 'SUFFIX',
};

function nextField(current: PartKey, value: HeaderParts): PartKey | null {
  const fields = ORDER.filter((key) => key === 'subject' || value[key] !== undefined);
  const index = fields.indexOf(current);
  return fields[index + 1] ?? null;
}

/** Shared plain-text title editor used by both full-window editors. */
export function StructuredHeaderEditor({
  value,
  onChange,
  constrained = false,
  disabled = false,
  pulsing = false,
  density = 'regular',
  className = '',
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldIdPrefix = useId();
  const singlePart = structuredHeaderPartCount(value) === 1;
  const pulseStyle = useGenerationPulseSync(pulsing);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const field of root.querySelectorAll<HTMLTextAreaElement>('textarea')) {
      field.style.height = '0px';
      field.style.height = `${Math.max(25, field.scrollHeight)}px`;
    }
  }, [value]);

  const setPart = (key: PartKey, raw: string) => {
    const next = { ...value, [key]: raw };
    onChange(next as HeaderParts);
  };

  const onKeyDown = (key: PartKey) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const next = nextField(key, value);
    if (next) rootRef.current?.querySelector<HTMLTextAreaElement>(`[data-header-part="${next}"]`)?.focus();
  };

  const renderField = (key: PartKey) => {
    if (key !== 'subject' && value[key] === undefined) return null;
    const fieldId = `${fieldIdPrefix}-${key}`;
    return (
      <div className={`structured-header-row structured-header-row--${key}`} key={key}>
        {!singlePart && (
          <label className="structured-header-label" htmlFor={fieldId}>
            {PART_LABELS[key]}
          </label>
        )}
        <textarea
          id={fieldId}
          data-header-part={key}
          rows={1}
          value={value[key] ?? ''}
          disabled={disabled}
          aria-label={singlePart ? 'Header' : undefined}
          onChange={(event) => setPart(key, event.target.value.replace(/[\r\n]+/g, ' '))}
          onPaste={(event) => {
            event.preventDefault();
            const pasted = normalizeEditableHeader(event.clipboardData.getData('text/plain'));
            const field = event.currentTarget;
            const start = field.selectionStart;
            const end = field.selectionEnd;
            setPart(key, `${field.value.slice(0, start)}${pasted}${field.value.slice(end)}`);
          }}
          onKeyDown={onKeyDown(key)}
        />
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      style={pulseStyle}
      className={`structured-header-editor is-${density}${singlePart ? ' is-single-part' : ''}${constrained ? ' is-constrained' : ''}${pulsing ? ' is-pulsing' : ''}${className ? ` ${className}` : ''}`}
      aria-label={flattenHeaderParts(value)}
      onWheel={constrained ? (event) => {
        const root = event.currentTarget;
        if (root.scrollHeight <= root.clientHeight || event.deltaY === 0) return;
        event.preventDefault();
        const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight) || 24.3;
        root.scrollTop = Math.max(0, root.scrollTop + Math.sign(event.deltaY) * lineHeight);
      } : undefined}
    >
      {renderField('prefix')}
      {renderField('subject')}
      {renderField('question')}
      {renderField('suffix')}
    </div>
  );
}
