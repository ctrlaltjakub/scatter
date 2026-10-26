'use client';
import { useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { GROUP_LABEL_ZOOM_THRESHOLD } from '@/lib/asciiAura/groupLabels';
import { useNodeContentInteraction } from './NodeContentInteractionContext';
import type { ChatAnswerRef } from '@/store/chatTypes';
import { nodeRelations, relatedSelectedNodeId } from '@/lib/nodeRelations';

interface Props {
  term: string;
  /** ID of the node whose body contains this chip — used to look up whether
   *  this term has a corresponding child node spawned from THIS parent. */
  parentNodeId: string;
  /** Called with the term + any modifier-key flags from the click.
   *  Right now only `withModifier` is observed — Ctrl/Cmd-click spawns
   *  the new child with its bullets section pre-collapsed (the user
   *  sees just the opening paragraph; the bullets stay rendered but
   *  hidden until they un-collapse via the chevron). */
  onClick: (term: string, opts: { withModifier: boolean }) => void;
  /** Optional rich label to render INSTEAD of the bare `term` (e.g. a whole
   *  bullet title keeping its inline **bold**). `term` still drives the spawn,
   *  the explored-state lookup, and the tooltip. Defaults to `term`. */
  children?: ReactNode;
  /** Optional shared lookup for all chips in one rendered node body. */
  resolution?: ReferenceResolution;
}

export interface ReferenceResolution {
  childByTerm: ReadonlyMap<string, string>;
  selectedNodeId: string | null;
  highlightedTerm: string | null;
}

interface ReferenceState {
  childId: string | null;
  isChildSelected: boolean;
  isHighlighted: boolean;
}

const EMPTY_CHILD_BY_TERM: ReadonlyMap<string, string> = new Map();
const EMPTY_RESOLUTION: ReferenceResolution = {
  childByTerm: EMPTY_CHILD_BY_TERM,
  selectedNodeId: null,
  highlightedTerm: null,
};

function mapsEqual(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

export function referenceStateForTerm(
  resolution: ReferenceResolution,
  term: string,
): ReferenceState {
  const childId = resolution.childByTerm.get(term) ?? null;
  return {
    childId,
    isChildSelected: childId != null && resolution.selectedNodeId === childId,
    isHighlighted: resolution.highlightedTerm === term,
  };
}

/**
 * Shared reference lookup for all chips rendered inside one node body.
 *
 * A project update used to make every ReferenceChip scan every arrow.
 * On bullet-heavy projects that is chips × arrows synchronous work on
 * the browser's main thread. One cached relationship lookup now serves all
 * chips in a node body. Only a selected child of
 * THIS body enters its snapshot: unrelated focus and 2→3 multi-selection
 * changes must not invalidate every node's memoized text.
 */
export function useReferenceResolution(parentNodeId: string, sourceAnswer?: ChatAnswerRef): ReferenceResolution {
  const lastRef = useRef<ReferenceResolution>(EMPTY_RESOLUTION);

  return useSyncExternalStore(
    useGraphStore.subscribe,
    () => {
      const state = useGraphStore.getState();
      const proj = state.project;
      const relations = nodeRelations(proj?.arrows, parentNodeId, sourceAnswer);
      const selectedNodeId = relatedSelectedNodeId(proj?.selection, relations.termChildIds);
      const highlightedArrow = state.highlight?.arrowId ? proj?.arrows[state.highlight.arrowId] : undefined;
      const sameAnswer = !sourceAnswer || (highlightedArrow?.sourceAnswer?.turnId === sourceAnswer.turnId
        && highlightedArrow.sourceAnswer.versionCreatedAt === sourceAnswer.versionCreatedAt);
      const highlightedTerm = sameAnswer && state.highlight?.parentNodeId === parentNodeId
        ? state.highlight.term ?? null : null;

      const childByTerm = relations.childByTerm;

      const prev = lastRef.current;
      if (
        prev.selectedNodeId === selectedNodeId
        && prev.highlightedTerm === highlightedTerm
        && mapsEqual(prev.childByTerm, childByTerm)
      ) {
        return prev;
      }

      const next: ReferenceResolution = {
        childByTerm: mapsEqual(prev.childByTerm, childByTerm)
          ? prev.childByTerm
          : childByTerm,
        selectedNodeId,
        highlightedTerm,
      };
      lastRef.current = next;
      return next;
    },
    () => EMPTY_RESOLUTION,
  );
}

/**
 * Inline reference button rendered for every `[[term]]` in a node body.
 *
 * Visual states (three distinct looks):
 * - `unexplored` — no child yet for this term. Rendered as underlined
 *   text inline with the rest, no background.
 * - `explored`   — a child node has been spawned but is not currently
 *   focused. Light gray text-highlight background (marker-pen style;
 *   sits flush against the text outline with no layout shift).
 * - `active`     — child is in the current selection OR the store's
 *   transient `highlight` targets this exact parent+term. Darker grey
 *   highlight + bold weight to stand out at a glance from explored.
 *   Pulse animation plays on the transition into this state.
 *
 * Clicking an already-explored term is handled at the page level
 *   (page.tsx → onReferenceClick): it focuses the existing child rather
 *   than spawning a duplicate.
 */
export function ReferenceChip(props: Props) {
  if (props.resolution) {
    return (
      <ReferenceChipView
        term={props.term}
        parentNodeId={props.parentNodeId}
        onClick={props.onClick}
        state={referenceStateForTerm(props.resolution, props.term)}
      >
        {props.children}
      </ReferenceChipView>
    );
  }
  return <ReferenceChipConnected {...props} />;
}

function ReferenceChipConnected({ term, parentNodeId, onClick, children }: Props) {
  const resolution = useReferenceResolution(parentNodeId);
  return (
    <ReferenceChipView
      term={term}
      parentNodeId={parentNodeId}
      onClick={onClick}
      state={referenceStateForTerm(resolution, term)}
    >
      {children}
    </ReferenceChipView>
  );
}

function ReferenceChipView({
  term,
  parentNodeId,
  onClick,
  children,
  state,
}: {
  term: string;
  parentNodeId: string;
  onClick: (term: string, opts: { withModifier: boolean }) => void;
  children?: ReactNode;
  state: ReferenceState;
}) {
  const interaction = useNodeContentInteraction();
  // Read zoom only at activation time. Subscribing every inline chip to the
  // 35% boundary made hundreds of terms re-render in one frame. The card's
  // overview surface already covers its hidden body; this guard preserves
  // programmatic/keyboard safety without threshold-time React work.
  const disabledByZoom = () => (
    !interaction?.ignoreCanvasZoomForTerms
    && useLiveViewportStore.getState().zoom < GROUP_LABEL_ZOOM_THRESHOLD
  );
  const childId = state.childId;
  const isActive = state.isChildSelected || state.isHighlighted;
  const isExplored = !!childId;
  const stateCls = isActive ? 'active' : isExplored ? 'explored' : 'unexplored';
  const cls = `ref-chip ${stateCls}`;

  return (
    // A <span role="button"> (not a real <button>): Firefox refuses to wrap text
    // INSIDE a <button> across lines no matter the CSS, so multi-word chips like
    // "double empathy problem" never broke to a second line. A span wraps
    // naturally (white-space:normal + box-decoration-break:clone in CSS) and is
    // also cleaner to select/copy. Keyboard support is added back manually.
    <span
      className={cls}
      role="button"
      aria-disabled={false}
      tabIndex={0}
      data-reference-parent-id={parentNodeId}
      data-reference-term={term}
      data-relation-child-id={childId ?? undefined}
      onMouseDown={(e) => { e.stopPropagation(); }}
      onClick={(e) => {
        e.stopPropagation();
        if (disabledByZoom()) return;
        onClick(term, { withModifier: e.ctrlKey || e.metaKey });
      }}
      onKeyDown={(e) => {
        if (disabledByZoom()) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onClick(term, { withModifier: e.ctrlKey || e.metaKey });
        }
      }}
      /* Terms use their dedicated preview, never a generic control tooltip. */
    >
      {children ?? term}
    </span>
  );
}
