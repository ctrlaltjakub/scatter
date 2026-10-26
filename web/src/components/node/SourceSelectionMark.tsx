'use client';
import type { ReactNode } from 'react';
import type { Arrow } from '@/store/types';
import { navigateExistingRelation } from '@/lib/relationNavigation';

interface Props {
  arrow: Arrow;
  active: boolean;
  children: ReactNode;
  /** Visual-only marks can live inside another interactive element (such as
   * an unexplored reference chip) without creating nested button semantics. */
  interactive?: boolean;
  startsSegment?: boolean;
  endsSegment?: boolean;
}

/** A layout-neutral, chip-equivalent link from selected source prose to a child. */
export function SourceSelectionMark({
  arrow,
  active,
  children,
  interactive = true,
  startsSegment = false,
  endsSegment = false,
}: Props) {
  const label = arrow.sourceSelection?.text ?? 'selected text';
  const navigate = () => navigateExistingRelation(arrow);
  const className = [
    'source-selection-mark',
    active ? 'active' : 'explored',
    startsSegment ? 'source-selection-mark--start' : '',
    endsSegment ? 'source-selection-mark--end' : '',
  ].filter(Boolean).join(' ');
  const readingRelationProps = {
    'data-reading-relation-kind': 'selection',
    'data-reading-relation-parent-id': arrow.fromNodeId,
    'data-reading-relation-child-id': arrow.toNodeId,
  } as const;
  if (!interactive) {
    return (
      <span
        className={className}
        data-arrow-id={arrow.id}
        data-relation-arrow-id={arrow.id}
        {...readingRelationProps}
      >
        {children}
      </span>
    );
  }
  return (
    <span
      className={className}
      role="button"
      tabIndex={0}
      aria-label={`Show "${label}"`}
      data-tip={`Show "${label}"`}
      data-arrow-id={arrow.id}
      data-relation-arrow-id={arrow.id}
      {...readingRelationProps}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        navigate();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        navigate();
      }}
    >
      {children}
    </span>
  );
}
