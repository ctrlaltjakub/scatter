'use client';

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { HeaderParts } from '@/store/types';
import { fitHeaderParts, flattenHeaderParts, normalizeHeaderParts } from '@/lib/nodeHeaderText';
import { useGenerationPulseSync } from '@/hooks/useGenerationPulseSync';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useInlineTextEdit } from '@/hooks/useInlineTextEdit';

interface Props {
  parts: HeaderParts;
  generating?: boolean;
  pendingTitle?: boolean;
  /** Optional center-aligned header control (used by empty media nodes). */
  centerControl?: ReactNode;
  onSave?: (title: string) => void;
  editNonce?: number;
}

export function HeaderText({ parts }: { parts: HeaderParts }) {
  return (
    <>
      {parts.prefix && <span className="node-title-addon node-title-prefix">{parts.prefix}:</span>}
      {parts.prefix && parts.subject && ' '}
      {parts.subject && <span className="node-title-subject">{parts.subject}</span>}
      {parts.question && <><span aria-hidden="true">: </span><span className="node-title-question">{parts.question}</span></>}
      {parts.suffix && <><span aria-hidden="true"> </span><span className="node-title-addon node-title-suffix">- {parts.suffix}</span></>}
    </>
  );
}

interface FittedHeaderTextProps {
  parts: HeaderParts;
  className?: string;
  generating?: boolean;
  pendingTitle?: boolean;
  maxLines?: number;
  style?: CSSProperties;
  onSave?: (title: string) => void;
  editNonce?: number;
}

/** The shared responsive three-line title used by cards and the interactive
 * viewer. It preserves complete semantic parts while shortening the subject
 * first, then the question, exactly like the canvas node. */
export function FittedHeaderText({
  parts: rawParts,
  className = '',
  generating = false,
  pendingTitle = false,
  maxLines = 3,
  style,
  onSave,
  editNonce,
}: FittedHeaderTextProps) {
  const parts = normalizeHeaderParts(rawParts);
  const [visible, setVisible] = useState(parts);
  const { textRef: titleRef, editing, editorProps } = useInlineTextEdit<HTMLHeadingElement>(flattenHeaderParts(parts), onSave, editNonce);
  const measureRef = useRef<HTMLHeadingElement>(null);
  const pulseStyle = useGenerationPulseSync(generating);
  const combinedStyle = style || pulseStyle ? { ...style, ...pulseStyle } : undefined;
  const titleClassName = `node-title${className ? ` ${className}` : ''}`;
  const nodeFontId = useSettingsStore((state) => state.nodeFontId);

  const fit = useCallback(() => {
    if (editing) return;
    const title = titleRef.current;
    const measure = measureRef.current;
    if (!title || !measure) return;
    measure.style.width = `${title.clientWidth}px`;
    const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight) || 24.3;
    const fits = (candidate: HeaderParts) => {
      measure.replaceChildren();
      const prefix = candidate.prefix ? `${candidate.prefix}:` : '';
      if (prefix) {
        const el = document.createElement('span');
        el.className = 'node-title-addon';
        el.textContent = prefix;
        measure.append(el);
        if (candidate.subject) measure.append(' ');
      }
      if (candidate.subject) measure.append(candidate.subject);
      if (candidate.question) measure.append(`${candidate.subject ? ': ' : ''}${candidate.question}`);
      if (candidate.suffix) {
        measure.append(' ');
        const el = document.createElement('span');
        el.className = 'node-title-addon';
        el.textContent = `- ${candidate.suffix}`;
        measure.append(el);
      }
      return measure.scrollHeight <= lineHeight * Math.max(1, maxLines) + 1;
    };

    const next = fitHeaderParts(parts, fits);
    setVisible((previous) => (
      flattenHeaderParts(previous) === flattenHeaderParts(next) ? previous : next
    ));
  }, [editing, maxLines, parts.prefix, parts.question, parts.subject, parts.suffix, nodeFontId, titleRef]);

  useLayoutEffect(() => {
    fit();
    const title = titleRef.current;
    if (!title) return;
    const observer = new ResizeObserver(fit);
    observer.observe(title);
    void document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [fit]);

  return (
    <>
      <h3
        key={editing ? 'editing' : 'display'}
        ref={titleRef}
        className={`${titleClassName}${generating ? ' is-generating' : ''}${editing ? ' is-editing' : ''}`}
        style={combinedStyle}
        {...editorProps}
        aria-label={editing ? 'Edit header' : flattenHeaderParts(parts)}
      >
        {editing ? flattenHeaderParts(parts) : <HeaderText parts={visible} />}
        {!editing && pendingTitle && <span className="group-title-dots" aria-hidden="true">...</span>}
      </h3>
      <h3
        ref={measureRef}
        className={`${titleClassName} node-title-measure`}
        aria-hidden="true"
      />
    </>
  );
}

/** Responsive three-line card title. Complete text remains in `aria-label`. */
export function NodeHeader({ parts, generating = false, pendingTitle = false, centerControl, onSave, editNonce }: Props) {
  return (
    <div className="node-header">
      <FittedHeaderText parts={parts} generating={generating} pendingTitle={pendingTitle} onSave={onSave} editNonce={editNonce} />
      {centerControl}
    </div>
  );
}
