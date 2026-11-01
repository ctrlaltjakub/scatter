'use client';
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ReferenceChip,
  useReferenceResolution,
  type ReferenceResolution,
} from '@/components/node/ReferenceChip';
import { CitationMarker } from '@/components/node/CitationMarker';
import { parseBody, stabilizeParsed, bulletsToPlainText, type Bullet, type ParsedBody } from '@/lib/bulletParse';
import { explicitLineSegments, hasParagraphBreak } from '@/lib/proseLines';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';
import { computeModes, heightOf, maxMode, type Heights, type Mode } from '@/lib/bulletLayout';
import { stripChipMarkers, wholeTerm, findBulletIdxContainingTerm } from '@/lib/bulletTerms';
import { createLazyCascadeStates, type CascadeStatesLookup } from '@/lib/cascadePrecompute';
import {
  measureWidthFor, MIN_NODE_W, DEFAULT_NODE_W, widthForAspectCap, ASPECT_MAX_RATIO,
} from '@/lib/nodeSize';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useActiveRecords, useRewriteStore } from '@/store/useRewriteStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { useReadingStore } from '@/store/useReadingStore';
import { DEFAULT_BULLET_SIZING_CONFIG } from '@/lib/bulletSizingDefaults';
import { APP_FONT_ID, ensureReadingFontLoaded } from '@/lib/imageEditFonts';
import { SourceSelectionMark } from '@/components/node/SourceSelectionMark';
import { SourceSelectionOutline } from '@/components/node/SourceSelectionOutline';
import { resolveArrowSourceSelection } from '@/lib/sourceSelection';
import type { Arrow } from '@/store/types';
import { useGenerationPulseSync } from '@/hooks/useGenerationPulseSync';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { termLabel } from '@/lib/termLabel';
import { inlineEmphasis } from '@/lib/inlineEmphasis';
import { nodeRelations, relatedSelectedNodeId } from '@/lib/nodeRelations';
import type { FactCheckUnit } from '@/store/types';

interface Props {
  body: string;
  readingFamily?: string;
  parentNodeId: string;
  onReferenceClick: (term: string, opts: { withModifier: boolean }) => void;
  /** Render only the opening paragraph. Used while the node's bullet section is collapsed. */
  collapsed?: boolean;
  /** Keep the visible bullet list mounted but hidden while collapsed. */
  parkCollapsedList?: boolean;
  /** Temporarily skip hidden measurement labs while showing cached expanded content. */
  deferHiddenLabs?: boolean;
  /** Reports the measured freetext height (CSS pixels) up to the
   *  outer node so it can compute the collapsed body height for the
   *  chevron toggle in node-footer. Stable callback identity is
   *  important — NodeView wraps the setState in useCallback([]). */
  onFreeTextH?: (h: number) => void;
}

interface FactReviewPresentation {
  units: Map<string, FactCheckUnit>;
  activeUnitId: string | null;
  activate: (unitId: string) => void;
}

function factUnitClass(unit: FactCheckUnit | undefined, active: boolean): string {
  if (!unit) return '';
  const verdict = unit.finding?.verdict ?? (unit.state === 'failed' ? 'failed' : 'pending');
  return ` fact-check-unit fact-${verdict}${active ? ' fact-active' : ''}`;
}

function factClick(
  event: ReactMouseEvent,
  unitId: string,
  presentation: FactReviewPresentation | undefined,
): void {
  if (!presentation || !window.getSelection()?.isCollapsed) return;
  const target = event.target as HTMLElement;
  if (target.closest('.ref-chip, .cite-marker, .source-selection-mark[role], [data-source-selection-outline], a, button')) return;
  event.stopPropagation();
  presentation.activate(unitId);
}

function factKeyDown(
  event: ReactKeyboardEvent,
  unitId: string,
  presentation: FactReviewPresentation | undefined,
): void {
  if (!presentation || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  event.stopPropagation();
  presentation.activate(unitId);
}

// Cascade-time line-height estimates. Real wrapping deviates from these,
// so the measure-correct loop adjusts modes after every render based on
// actual rendered heights.
const HEIGHTS: Heights = { title: 28, inline: 22, described: 22 };
// Overhead inside .sc-ab-root that isn't bullet content: the CSS flex gap
// between the free-text region and the bullet list. .sc-ab-root itself
// has no padding, and containerH already excludes the parent .node-body's
// padding (height: 100% of body's content area). So this is just the gap.
const FLEX_GAP = 6;
// Body-side overhead when sizing the node body so that a desired
// items-area height fits: flex gap + .node-body's CSS padding (top 4 +
// bottom 12).
const BODY_OVERHEAD = FLEX_GAP + 16;
// These constants are the FALLBACK values — they're now overridable from
// the dev-settings UI ("Bullet sizing" section). Component reads the
// live values from useSettingsStore.bulletSizingConfig and falls back to
// DEFAULT_BULLET_SIZING_CONFIG (defined in lib/bulletSizingDefaults.ts)
// when nothing is overridden.
const OVERFLOW_TOLERANCE_DEFAULT = DEFAULT_BULLET_SIZING_CONFIG.overflowTolerance;
const UNDERFLOW_TOLERANCE_DEFAULT = DEFAULT_BULLET_SIZING_CONFIG.underflowTolerance;
const MAX_ADJUSTMENT_ITER_DEFAULT = DEFAULT_BULLET_SIZING_CONFIG.maxAdjustmentIter;

// While a node's LLM stream rewrites `body` every animation frame, the lab
// offsetHeight sweeps run at most once per this interval instead of per body
// change — per-frame forced layout over ~6×N lab items made long-node
// streaming O(n²) and froze scrolling. The node's growth tracking just runs
// at ~2Hz during the stream (imperceptible); the final ungated measure at
// generating:false commits the exact end state.
const STREAM_MEASURE_MS = 450;

// Height reserved in the streamed body cap for the tail skeleton — the ghost
// bullet rendered after the list while pass-1 text streams (`streamingText`),
// signalling that more bullets are coming between bullet-boundary commits.
// MUST equal the rendered height of `.sc-ab-skel-bullet` (globals.css):
// margin-top 8 + title bar 14 + gap 9 + line 11 + gap 9 + line 11 = 62px.
// The reserve is ADDED to the body cap and SUBTRACTED from every cascade
// `avail` computation, so the skeleton gets its own strip and real bullets
// keep exactly the space they'd have without it — persisted sizes stay
// identical to a run that never showed a skeleton.
export const STREAM_SKELETON_RESERVE = 62;

// The hidden measurement lists are pinned to MEASURE_WIDTH — the body
// content width at the node's MIN_NODE_W (the narrowest the resize
// handle ever allows). This makes the computed minBodyHeight a worst-
// case floor: at narrower widths titles wrap to more lines, so items
// are taller and A is larger; at wider widths items shorten, so the
// same floor is conservatively safe. MEASURE_WIDTH lives in nodeSize.ts
// (single source of truth, guarded against CSS drift by
// measureWidth.test.ts) — it MUST equal MIN_NODE_W − border − body
// padding, or the labs measure at the wrong width and tall bullets
// overflow.

// Extra safety reserved in minBodyHeight beyond the strict A/B math.
// We're trading a slightly bigger floor for the guarantee that activate
// and collapse NEVER change the node size — a stable card is much
// nicer to interact with than a precise but jittery one. The safety is
// the LARGER of an absolute floor and a fraction of the total raw size
// so short and tall content both get adequate buffer.
//
// Absorbs:
//  - cascade OVERFLOW_TOLERANCE (4 px the measure-correct loop allows
//    above avail before demoting),
//  - sub-pixel rounding when measuring item heights,
//  - any hidden-vs-visible measurement gap (font-rendering jitter,
//    pseudo-element heights, etc.) the architecture might miss.
const MIN_SIZE_SAFETY_PX_DEFAULT = DEFAULT_BULLET_SIZING_CONFIG.safetyMinPx;
const MIN_SIZE_SAFETY_FRACTION_DEFAULT = DEFAULT_BULLET_SIZING_CONFIG.safetyFraction;

// The per-measurement sizing log fires on EVERY min-height measurement —
// during a streaming pass that's every frame, and console formatting is real
// main-thread cost (especially with DevTools open). Off by default; the
// sizing math stays inspectable via the data-sc-* attributes on .sc-ab-root.
// To re-enable: localStorage.setItem('sc-sizing-log', '1') and reload.
const SIZING_LOG = (() => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('sc-sizing-log') === '1';
  } catch {
    return false;
  }
})();

function layoutHeight(el: HTMLElement): number {
  return el.offsetHeight || el.getBoundingClientRect().height;
}

function layoutWidth(el: HTMLElement): number {
  return el.offsetWidth || el.getBoundingClientRect().width;
}

interface PersistentSourceMark {
  displayStart: number;
  displayEnd: number;
  arrow: Arrow;
  active: boolean;
}

interface FieldSourceMarks {
  persistent: PersistentSourceMark[];
  modifying: Array<{ displayStart: number; displayEnd: number }>;
}

type SourceMarksByField = ReadonlyMap<string, FieldSourceMarks>;

interface DisplayRange {
  start: number;
  end: number;
}

interface RichTextContext {
  marks?: FieldSourceMarks;
  chipMasks: DisplayRange[];
  displayOffset: number;
  markInteractive?: boolean;
}

/** Visible text and chip ranges produced by the same marker grammar as richText. */
function projectRichText(text: string): { text: string; chips: Array<DisplayRange & { term: string }> } {
  let visible = '';
  const chips: Array<DisplayRange & { term: string }> = [];
  const emphasis = inlineEmphasis(text);
  for (let i = 0; i < text.length;) {
    const span = emphasis.get(i);
    if (span) {
      const inner = projectRichText(text.slice(span.contentStart, span.contentEnd));
      const base = visible.length;
      visible += inner.text;
      chips.push(...inner.chips.map((chip) => ({
        start: chip.start + base,
        end: chip.end + base,
        term: chip.term,
      })));
      i = span.end;
      continue;
    }
    if (text[i] === '[' && text[i + 1] === '[') {
      const end = text.indexOf(']]', i + 2);
      if (end > i + 2) {
        const raw = text.slice(i + 2, end).trim();
        const term = termLabel(raw).text;
        const start = visible.length;
        visible += term;
        chips.push({ start, end: visible.length, term });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '⟦') {
      const end = text.indexOf('⟧', i + 1);
      const digits = end > i + 1 ? text.slice(i + 1, end) : '';
      if (/^\d+$/.test(digits)) {
        visible += `[${digits}]`;
        i = end + 1;
        continue;
      }
    }
    if (text[i] === '⦅') {
      const end = text.indexOf('⦆', i + 1);
      const digits = end > i + 1 ? text.slice(i + 1, end) : '';
      if (/^\d+$/.test(digits)) {
        visible += `(${digits})`;
        i = end + 1;
        continue;
      }
    }
    visible += text[i];
    i += 1;
  }
  return { text: visible, chips };
}

function richTextContext(
  text: string,
  marks?: FieldSourceMarks,
  resolution?: ReferenceResolution,
  markInteractive = true,
): RichTextContext {
  const projected = projectRichText(text);
  const chipMasks = projected.chips
    .filter((chip) => resolution?.childByTerm.has(chip.term))
    .map((chip) => ({
      start: chip.start > 0 && /\s/.test(projected.text[chip.start - 1] ?? '')
        ? chip.start - 1
        : chip.start,
      end: chip.end < projected.text.length && /\s/.test(projected.text[chip.end] ?? '')
        ? chip.end + 1
        : chip.end,
    }));
  return { marks, chipMasks, displayOffset: 0, markInteractive };
}

function isMasked(position: number, masks: DisplayRange[]): boolean {
  return masks.some((mask) => position >= mask.start && position < mask.end);
}

function ownerAt(position: number, context?: RichTextContext): PersistentSourceMark | null {
  if (!context?.marks || isMasked(position, context.chipMasks)) return null;
  let owner: PersistentSourceMark | null = null;
  for (const mark of context.marks.persistent) {
    if (position < mark.displayStart || position >= mark.displayEnd) continue;
    if (
      !owner
      || mark.arrow.sourceSelection!.createdAt > owner.arrow.sourceSelection!.createdAt
      || (
        mark.arrow.sourceSelection!.createdAt === owner.arrow.sourceSelection!.createdAt
        && mark.arrow.id > owner.arrow.id
      )
    ) owner = mark;
  }
  return owner;
}

function modifyingAt(position: number, context?: RichTextContext): boolean {
  return context?.marks?.modifying.some(
    (range) => position >= range.displayStart && position < range.displayEnd,
  ) ?? false;
}

function modifyingAcross(start: number, end: number, context?: RichTextContext): boolean {
  return context?.marks?.modifying.some(
    (range) => start < range.displayEnd && end > range.displayStart,
  ) ?? false;
}

function renderPlainRun(
  text: string,
  displayStart: number,
  context: RichTextContext | undefined,
  keyPrefix: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  let runStart = 0;
  while (runStart < text.length) {
    const owner = ownerAt(displayStart + runStart, context);
    const modifying = modifyingAt(displayStart + runStart, context);
    let runEnd = runStart + 1;
    while (
      runEnd < text.length
      && ownerAt(displayStart + runEnd, context)?.arrow.id === owner?.arrow.id
      && modifyingAt(displayStart + runEnd, context) === modifying
    ) runEnd += 1;
    const run = <span className="sc-ab-text">{text.slice(runStart, runEnd)}</span>;
    const absoluteStart = displayStart + runStart;
    const absoluteEnd = displayStart + runEnd;
    const marked = owner ? (
      <SourceSelectionMark
        arrow={owner.arrow}
        active={owner.active}
        interactive={context?.markInteractive !== false}
        startsSegment={ownerAt(absoluteStart - 1, context)?.arrow.id !== owner.arrow.id}
        endsSegment={ownerAt(absoluteEnd, context)?.arrow.id !== owner.arrow.id}
      >
        {run}
      </SourceSelectionMark>
    ) : run;
    out.push(modifying ? (
      <span key={`${keyPrefix}-${runStart}`} className="source-selection-modifying">
        {marked}
      </span>
    ) : (
      <Fragment key={`${keyPrefix}-${runStart}`}>{marked}</Fragment>
    ));
    runStart = runEnd;
  }
  return out;
}

/**
 * Render Markdown emphasis and [[ref]] tokens, with a shared visible-text
 * projection so selection highlights stay aligned after delimiters disappear.
 */
function richText(
  text: string,
  parentNodeId: string,
  onClick: (t: string, opts: { withModifier: boolean }) => void,
  resolution?: ReferenceResolution,
  context?: RichTextContext,
): ReactNode {
  const out: ReactNode[] = [];
  const emphasis = inlineEmphasis(text);
  let i = 0;
  let buf = '';
  let bufDisplayStart = context?.displayOffset ?? 0;
  let displayOffset = context?.displayOffset ?? 0;
  let key = 0;
  const flush = () => {
    if (buf) {
      // Wrap plain runs in an inline span so the cursor can show the text
      // I-beam ONLY over actual glyphs (the surrounding containers carry the
      // clickable/arrow cursor). Layout-neutral (unstyled inline span).
      out.push(...renderPlainRun(buf, bufDisplayStart, context, `t-${key++}`));
      buf = '';
    }
  };
  while (i < text.length) {
    const span = emphasis.get(i);
    if (span) {
      flush();
      const inner = text.slice(span.contentStart, span.contentEnd);
      const Tag = span.tag;
      out.push(
        <Tag key={`e-${key++}`}>{richText(inner, parentNodeId, onClick, resolution, {
          ...(context ?? { chipMasks: [] }),
          displayOffset,
        })}</Tag>,
      );
      displayOffset += projectRichText(inner).text.length;
      bufDisplayStart = displayOffset;
      i = span.end;
      continue;
    }
    if (text[i] === '[' && text[i + 1] === '[') {
      const end = text.indexOf(']]', i + 2);
      if (end > i + 2) {
        flush();
        const raw = text.slice(i + 2, end).trim();
        // Local term insertion can enclose mixed emphasis. Keep the clean
        // reference name separate from the label's individual styled runs.
        const label = termLabel(raw);
        const isBold = label.parts.length > 0 && label.parts.every((part) => part.bold);
        const term = label.text;
        const chipStart = displayOffset;
        const chip = (
          <ReferenceChip
            term={term}
            parentNodeId={parentNodeId}
            onClick={onClick}
            resolution={resolution}
          >
            {(() => {
              let offset = chipStart;
              return label.parts.map((part, partIndex) => {
                let content: ReactNode = renderPlainRun(part.text, offset, context ? {
                  ...context, marks: context.marks ? { ...context.marks, modifying: [] } : undefined,
                  markInteractive: false,
                } : undefined, `r-${key}-${partIndex}-${term}`);
                offset += part.text.length;
                if (part.italic) content = <em>{content}</em>;
                if (part.strike) content = <del>{content}</del>;
                if (part.bold && !isBold) content = <strong>{content}</strong>;
                return <Fragment key={partIndex}>{content}</Fragment>;
              });
            })()}
          </ReferenceChip>
        );
        const renderedChip = isBold ? <strong>{chip}</strong> : chip;
        out.push(modifyingAcross(chipStart, chipStart + term.length, context) ? (
          <span key={`rm-${key++}-${term}`} className="source-selection-modifying">
            {renderedChip}
          </span>
        ) : (
          <Fragment key={`r-${key++}-${term}`}>{renderedChip}</Fragment>
        ));
        displayOffset += term.length;
        bufDisplayStart = displayOffset;
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '⟦') {
      const end = text.indexOf('⟧', i + 1);
      const numStr = end > i + 1 ? text.slice(i + 1, end) : '';
      if (/^\d+$/.test(numStr)) {
        flush();
        const citationEnd = displayOffset + numStr.length + 2;
        const citation = <CitationMarker n={Number(numStr)} parentNodeId={parentNodeId} />;
        out.push(modifyingAcross(displayOffset, citationEnd, context) ? (
          <span key={`cm-${key++}`} className="source-selection-modifying">{citation}</span>
        ) : (
          <Fragment key={`c-${key++}`}>{citation}</Fragment>
        ));
        displayOffset += numStr.length + 2;
        bufDisplayStart = displayOffset;
        i = end + 1;
        continue;
      }
    }
    if (text[i] === '⦅') {
      const end = text.indexOf('⦆', i + 1);
      const numStr = end > i + 1 ? text.slice(i + 1, end) : '';
      if (/^\d+$/.test(numStr)) {
        flush();
        const citationEnd = displayOffset + numStr.length + 2;
        const citation = <CitationMarker n={Number(numStr)} parentNodeId={parentNodeId} internal />;
        out.push(modifyingAcross(displayOffset, citationEnd, context) ? (
          <span key={`icm-${key++}`} className="source-selection-modifying">{citation}</span>
        ) : (
          <Fragment key={`ic-${key++}`}>{citation}</Fragment>
        ));
        displayOffset += numStr.length + 2;
        bufDisplayStart = displayOffset;
        i = end + 1;
        continue;
      }
    }
    if (!buf) bufDisplayStart = displayOffset;
    buf += text[i];
    displayOffset += 1;
    i++;
  }
  flush();
  return out;
}

/**
 * Render the opening free-text paragraph. When `perLine` is true (the default),
 * each authored source line becomes its own block, without guessing sentence
 * boundaries from punctuation. When false, source lines flow within their
 * paragraph. Blank lines still separate paragraphs. Either way `richText` handles
 * **bold** and [[chips]]. The behavior is user-controlled via the
 * `sentencePerLine` setting (Settings → Canvas).
 *
 * MUST be used at BOTH the visible freetext div and the hidden measurement
 * clone with identical args (including `perLine`) — the clone's measured height
 * drives node sizing, so any structural divergence would desync the min size.
 */
function renderFreeText(
  text: string,
  parentNodeId: string,
  onClick: (t: string, opts: { withModifier: boolean }) => void,
  perLine: boolean,
  resolution?: ReferenceResolution,
  marks?: FieldSourceMarks,
  factReview?: FactReviewPresentation,
): ReactNode {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const context = richTextContext(normalized, marks, resolution);
  let displayOffset = 0;
  const lines = explicitLineSegments(text);
  return lines.map(({ text: line, start }, i) => {
    const sentence = line.replace(/\s+/g, ' ');
    const separator = i > 0 ? text.slice(lines[i - 1]!.end, start) : '';
    const paragraphStart = hasParagraphBreak(separator);
    const unitId = `opening:${i}`;
    const unit = factReview?.units.get(unitId);
    const node = (
      <span
        key={i}
        className={(perLine ? 'sc-ab-sentence' : 'sc-ab-flow-sentence') + (perLine && paragraphStart ? ' sc-ab-new-paragraph' : '') + factUnitClass(
          unit,
          factReview?.activeUnitId === unitId,
        )}
        data-fact-unit={unit ? unitId : undefined}
        onClick={unit ? (event) => factClick(event, unitId, factReview) : undefined}
        onKeyDown={unit ? (event) => factKeyDown(event, unitId, factReview) : undefined}
        role={unit ? 'button' : undefined}
        tabIndex={unit ? 0 : undefined}
        aria-label={unit ? `Review evidence for: ${unit.text}` : undefined}
        data-tip={unit ? 'Review evidence' : undefined}
      >
        {richText(sentence, parentNodeId, onClick, resolution, { ...context, displayOffset })}
      </span>
    );
    // Source-selection projections collapse whitespace between authored lines
    // to one character regardless of CRLF or blank paragraphs.
    displayOffset += projectRichText(sentence).text.length + 1;
    return <Fragment key={i}>{!perLine && i > 0 ? (paragraphStart ? <><br /><br /></> : '\n') : null}{node}</Fragment>;
  });
}

function arrEq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Renders the inner JSX of a bullet item at a given mode. Shared by the
 * visible cascade list and the hidden measurement lists so wrapping
 * behaviour stays identical.
 *
 * Level-1 titles and level-2 names become WHOLE clickable terms — but only when
 * the bullet is FULLY open (`m >= maxMode`, i.e. all children shown with
 * descriptions, same as `aria-expanded`). Collapsed / partially-open titles and
 * names render as plain text. Either way the AI's partial `[[ ]]` markings
 * inside a title/name are stripped (ignored) — titles never surface partial
 * chips. Descriptions and the opening paragraph keep their normal word-level
 * chips.
 */
export function renderBulletInner(
  b: Bullet,
  m: Mode,
  parentNodeId: string,
  onRef: (t: string, opts: { withModifier: boolean }) => void,
  resolution?: ReferenceResolution,
  bulletIndex = 0,
  sourceMarks?: SourceMarksByField,
  factReview?: FactReviewPresentation,
): ReactNode {
  const max = maxMode(b);
  const N = b.children.length;
  const describedCount = m >= max ? N : Math.max(0, m - 1);
  const described = b.children.slice(0, describedCount);
  const inline = b.children.slice(describedCount);
  // A whole title/name rendered as one clickable term, ALWAYS (collapsed,
  // inline, or fully open). `term` is the clean (marker- and bold-stripped)
  // text; the visible label keeps inline bold. The AI's partial `[[ ]]`
  // markings inside a title/name are stripped so titles never surface partial
  // chips. Descriptions keep their own word-level chips below.
  const wholeTermLabel = (text: string, sourceField: string): ReactNode => (
    <span data-sc-source-field={sourceField}>
      <ReferenceChip
        term={wholeTerm(text)}
        parentNodeId={parentNodeId}
        onClick={onRef}
        resolution={resolution}
      >
        {(() => {
          const visibleText = stripChipMarkers(text);
          const field = sourceMarks?.get(sourceField);
          const clicked = resolution?.childByTerm.has(wholeTerm(text)) ?? false;
          const visibleMarks = field
            ? {
              persistent: clicked ? [] : field.persistent,
              modifying: field.modifying,
            }
            : undefined;
          return richText(
            visibleText,
            parentNodeId,
            onRef,
            resolution,
            richTextContext(visibleText, visibleMarks, resolution, false),
          );
        })()}
      </ReferenceChip>
    </span>
  );
  return (
    <>
      <div className="sc-ab-title">
        <span className="sc-ab-bullet-mark">•</span>
        <span className="sc-ab-title-text">
          {wholeTermLabel(b.title, `b:${bulletIndex}:title`)}
        </span>
      </div>
      {described.map((c, j) => (
        <div
          key={`d${j}`}
          className={'sc-ab-described' + factUnitClass(
            factReview?.units.get(`bullet:${bulletIndex}:${j}`),
            factReview?.activeUnitId === `bullet:${bulletIndex}:${j}`,
          )}
          data-fact-unit={factReview?.units.has(`bullet:${bulletIndex}:${j}`)
            ? `bullet:${bulletIndex}:${j}`
            : undefined}
          onClick={factReview?.units.has(`bullet:${bulletIndex}:${j}`)
            ? (event) => factClick(event, `bullet:${bulletIndex}:${j}`, factReview)
            : undefined}
          onKeyDown={factReview?.units.has(`bullet:${bulletIndex}:${j}`)
            ? (event) => factKeyDown(event, `bullet:${bulletIndex}:${j}`, factReview)
            : undefined}
          role={factReview?.units.has(`bullet:${bulletIndex}:${j}`) ? 'button' : undefined}
          tabIndex={factReview?.units.has(`bullet:${bulletIndex}:${j}`) ? 0 : undefined}
          aria-label={factReview?.units.has(`bullet:${bulletIndex}:${j}`)
            ? `Review evidence for: ${factReview.units.get(`bullet:${bulletIndex}:${j}`)?.text}`
            : undefined}
          data-tip={factReview?.units.has(`bullet:${bulletIndex}:${j}`) ? 'Review evidence' : undefined}
        >
          <span className="sc-ab-child-mark">•</span>
          <span className="sc-ab-described-body">
            <span className="sc-ab-name">{wholeTermLabel(c.name, `b:${bulletIndex}:c:${j}:name`)}</span>
            <span className="sc-ab-sep">: </span>
            <span className="sc-ab-desc" data-sc-source-field={`b:${bulletIndex}:c:${j}:desc`}>{richText(
              c.desc,
              parentNodeId,
              onRef,
              resolution,
              richTextContext(
                c.desc,
                sourceMarks?.get(`b:${bulletIndex}:c:${j}:desc`),
                resolution,
              ),
            )}</span>
          </span>
        </div>
      ))}
      {m >= 1 && inline.length > 0 && (
        <div className="sc-ab-inline">
          {inline.map((c, j) => (
            // Separator space MUST live outside the nowrap span — otherwise
            // there's no whitespace text node between adjacent inline names
            // for the browser to wrap at, and a long M1 row becomes one
            // un-breakable line that overflows horizontally.
            <Fragment key={`i${j}`}>
              {j > 0 && ' '}
              <span
                className={'sc-ab-inline-name' + factUnitClass(
                  factReview?.units.get(`bullet:${bulletIndex}:${describedCount + j}`),
                  factReview?.activeUnitId === `bullet:${bulletIndex}:${describedCount + j}`,
                )}
                data-fact-unit={factReview?.units.has(`bullet:${bulletIndex}:${describedCount + j}`)
                  ? `bullet:${bulletIndex}:${describedCount + j}`
                  : undefined}
                onClick={factReview?.units.has(`bullet:${bulletIndex}:${describedCount + j}`)
                  ? (event) => factClick(
                    event,
                    `bullet:${bulletIndex}:${describedCount + j}`,
                    factReview,
                  )
                  : undefined}
                onKeyDown={factReview?.units.has(`bullet:${bulletIndex}:${describedCount + j}`)
                  ? (event) => factKeyDown(
                    event,
                    `bullet:${bulletIndex}:${describedCount + j}`,
                    factReview,
                  )
                  : undefined}
                role={factReview?.units.has(`bullet:${bulletIndex}:${describedCount + j}`)
                  ? 'button'
                  : undefined}
                tabIndex={factReview?.units.has(`bullet:${bulletIndex}:${describedCount + j}`)
                  ? 0
                  : undefined}
                aria-label={factReview?.units.has(`bullet:${bulletIndex}:${describedCount + j}`)
                  ? `Review evidence for: ${factReview.units.get(`bullet:${bulletIndex}:${describedCount + j}`)?.text}`
                  : undefined}
                data-tip={factReview?.units.has(`bullet:${bulletIndex}:${describedCount + j}`) ? 'Review evidence' : undefined}
              >
                <span className="sc-ab-child-mark">•</span>{' '}
                {wholeTermLabel(c.name, `b:${bulletIndex}:c:${describedCount + j}:name`)}
              </span>
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Memoized wrapper around `renderBulletInner` — used by the visible list AND
 * all six hidden measurement labs. With bullet identities kept stable across
 * re-parses (see `stabilizeParsed`), React bails out of every list item whose
 * bullet/mode didn't change; during a streaming pass only the bullet at the
 * reveal boundary re-renders per frame instead of every bullet × 7 lists.
 * Untouched items keep their DOM (chips aren't remounted, so their store
 * subscriptions — and any in-progress text selection — survive the stream).
 */
const BulletItemInner = memo(function BulletItemInner({ b, m, parentNodeId, onRef, resolution, bulletIndex, sourceMarks, factReview }: {
  b: Bullet;
  m: Mode;
  parentNodeId: string;
  onRef: (t: string, opts: { withModifier: boolean }) => void;
  resolution?: ReferenceResolution;
  bulletIndex: number;
  sourceMarks?: SourceMarksByField;
  factReview?: FactReviewPresentation;
}) {
  return <>{renderBulletInner(b, m, parentNodeId, onRef, resolution, bulletIndex, sourceMarks, factReview)}</>;
});

/**
 * Renders a node body per the adaptive cascade.
 *
 * Sizing model (matches the prototype's contract):
 *
 *   min_body = max(A, B) + freeText + overhead, where
 *     A = max over i of (full_i + sum_{j != i}(m0_j))
 *           (longest bullet fully expanded + every other bullet collapsed
 *            to a title-only row — guarantees any single click fits)
 *     B = sum(M1 per bullet)
 *           (all bullets at one inline-group line each — guarantees the
 *            "all uniformly at M1" state fits)
 *
 * Architecture:
 *   - The VISIBLE list runs the cascade (uniform-first promote, top-down
 *     demote on overflow, with the active bullet held at M_max).
 *   - Three HIDDEN parallel lists, position-absolute inside .sc-ab-root,
 *     render the same bullets at fixed modes — M_max, M0, M1 — so we can
 *     read per-bullet heights without ever forcing the visible list
 *     through measurement modes. This means an active bullet stays
 *     expanded during a resize (no flicker) and minBodyHeight is always
 *     accurate for the current width.
 *
 * The hidden lists re-layout automatically whenever container width
 * changes (text wraps differently), so the measurement effect simply
 * reads them on every relevant render.
 */
export function AdaptiveBullets({
  body,
  readingFamily,
  parentNodeId,
  onReferenceClick,
  onFreeTextH,
  collapsed = false,
  parkCollapsedList = false,
  deferHiddenLabs = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const freeTextRef = useRef<HTMLDivElement>(null);
  const visibleListRef = useRef<HTMLUListElement>(null);
  const hiddenFullRef = useRef<HTMLUListElement>(null);
  const hiddenM0Ref = useRef<HTMLUListElement>(null);
  const hiddenM1Ref = useRef<HTMLUListElement>(null);
  // ── Current-width labs (second set) ──────────────────────────────
  // The existing labs above render at fixed MEASURE_WIDTH (~MIN_NODE_W
  // - padding) for the worst-case minBodyHeight calculation. These
  // additional labs render at the CURRENT containerW. Per-bullet
  // heights from these labs feed the `cascadeStates` precomputation
  // — exact heights at the width the user is currently viewing, so
  // the precomputed converged states match what measure-correct
  // would converge to.
  const hiddenCurFullRef = useRef<HTMLUListElement>(null);
  const hiddenCurM0Ref = useRef<HTMLUListElement>(null);
  const hiddenCurM1Ref = useRef<HTMLUListElement>(null);
  const hiddenFreeTextRef = useRef<HTMLDivElement>(null);
  const [containerH, setContainerH] = useState(0);
  const [containerW, setContainerW] = useState(0);
  const [freeTextH, setFreeTextH] = useState(0);
  // activeIdx lives in a transient store so the scrollbar (rendered
  // in NodeView, outside the AdaptiveBullets subtree) and side-panel
  // "Expand selected" button can read+write the same value. null
  // means "no L1 forced active". Updates via `setActiveIdx` are
  // routed through the store's set method below.
  const activeIdx = useActiveIdxStore(
    (s) => s.byNodeId[parentNodeId] ?? null,
  );
  const setActiveIdx = useCallback((next: number | null) => {
    useActiveIdxStore.getState().set(parentNodeId, next);
  }, [parentNodeId]);
  const currentVersionCreatedAt = useGraphStore((s) => {
    const node = s.project?.nodes[parentNodeId];
    return node?.versions[node.currentVersionIndex]?.createdAt;
  });
  // Opening chat history/sources is not a text change. Subscribe only to
  // fact review for this exact body, not the globally open panel's identity.
  const reviewingFacts = useCitationPanelStore((s) => s.mode === 'fact-check'
    && s.nodeId === parentNodeId && s.factVersionCreatedAt === currentVersionCreatedAt);
  const activeFactUnitId = useCitationPanelStore((s) => s.mode === 'fact-check'
    && s.nodeId === parentNodeId && s.factVersionCreatedAt === currentVersionCreatedAt
    ? s.activeFactUnitId : null);
  const factVersion = useGraphStore((s) => {
    if (!reviewingFacts) return undefined;
    const node = s.project?.nodes[parentNodeId];
    if (!node || node.versions[node.currentVersionIndex]?.createdAt !== currentVersionCreatedAt) return undefined;
    return node.versions[node.currentVersionIndex];
  });
  const factBodyFingerprint = useMemo(() => factVersion?.factCheck ? factCheckBodyFingerprint(factVersion) : undefined,
    // Fact-unit streaming and unrelated graph movement must not rehash prose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [factVersion?.body, factVersion?.header, factVersion?.chat?.question, !!factVersion?.chat, !!factVersion?.factCheck]);
  const savedFactReport = factVersion?.factCheck?.pending ?? factVersion?.factCheck?.complete;
  const factReport = savedFactReport?.bodyFingerprint === factBodyFingerprint ? savedFactReport : undefined;
  const internalCitationSignature = useGraphStore((s) => {
    const node = s.project?.nodes[parentNodeId];
    return node?.versions[node.currentVersionIndex]?.internalSources?.map((source) => source.n).join(',') ?? '';
  });
  const factReview = useMemo<FactReviewPresentation | undefined>(() => {
    if (!factReport) return undefined;
    return {
      units: new Map(factReport.units.map((unit) => [unit.id, unit])),
      activeUnitId: activeFactUnitId,
      activate: (unitId) => {
        useCitationPanelStore.getState().setFactUnit(parentNodeId, unitId);
        const match = /^bullet:(\d+):/.exec(unitId);
        useActiveIdxStore.getState().set(
          parentNodeId,
          match ? Number(match[1]) : null,
        );
      },
    };
  }, [factReport, activeFactUnitId, parentNodeId]);
  const [modes, setModes] = useState<Mode[]>([]);

  // ── Lab-derived Heights for the cascade SEED ───────────────────
  // Mirrors the hidden labs' per-bullet M0/M1/M_max measurements
  // into state. `measuredHeights` (computed below) averages them
  // into a Heights tuple used as a FALLBACK for the cascade seed
  // when `cascadeStates` (the precomputed-per-activeIdx Map) isn't
  // yet available (first render, before current-width labs measure).
  interface LabHeights { m0: number[]; m1: number[]; full: number[] }
  const [labHeights, setLabHeights] = useState<LabHeights | null>(null);
  /** Per-bullet M0/M1/M_max heights measured at the CURRENT
   *  containerW (not the worst-case MIN_NODE_W of `labHeights`).
   *  Feeds `cascadeStates` precomputation. Null until current-width
   *  labs first measure. */
  const [curLabs, setCurLabs] = useState<LabHeights | null>(null);
  /** Render-time mirror of `curLabs` so the current-width measure effect can
   *  check stability without listing curLabs in its deps (which would re-run
   *  the O(bullets) DOM reads on every cascade update). */
  const curLabsRef = useRef(curLabs);
  curLabsRef.current = curLabs;
  /** Lab-lifecycle latch. The six hidden measurement lists are ~6× the body
   *  in DOM; keeping every expanded node's labs mounted forever made each
   *  style/layout/paint pass scale with total project text. Once a
   *  measurement pass finds nothing left to commit (floor sizes persisted,
   *  curLabs stable), `labsDone` unmounts the labs; any wrap-relevant input
   *  change (body, width, fonts, min-width) resets the latch so they remount,
   *  remeasure once, and unmount again. The two flags are re-derived by the
   *  measure effects each time they run and read by the no-deps latch effect
   *  below them — within the same commit, so they can't go stale. */
  const [labsDone, setLabsDone] = useState(false);
  const floorLabsStableRef = useRef(false);
  const curLabsStableRef = useRef(false);
  /** Bumped whenever a measure effect COMMITS a value. Both effects list it
   *  as a dep, so each commit is followed by exactly one verification pass —
   *  the pass that finds nothing left to change and sets the stable flags.
   *  (Without it the effects would never re-run after their own commit: the
   *  commit changes no other dep, and in jsdom no ResizeObserver refires.) */
  const [measureEpoch, setMeasureEpoch] = useState(0);
  /** Streaming measure cadence (see STREAM_MEASURE_MS). Bumped by an interval
   *  that runs only while this node is generating; monotonic, never reset.
   *  Each measure effect may sweep ONLY on a render where this advanced (its
   *  `seenTick` ref differs) AND the inputs it measures actually changed since
   *  its last sweep (`swept` ref) — so a static body during the chip-marking
   *  pass costs zero sweeps, and mid-frame body changes between ticks cost
   *  zero sweeps. */
  const [streamTick, setStreamTick] = useState(0);
  const floorSeenTickRef = useRef(-1);
  const floorSweptRef = useRef<{ body: string; w: number; r: number } | null>(null);
  const curSeenTickRef = useRef(-1);
  const curSweptRef = useRef<{ body: string; w: number } | null>(null);

  /** Tracks the activeIdx as it was during the LAST seed
   *  computation. Used by the swap-seed FALLBACK (only fires when
   *  cascadeStates isn't yet populated). */
  const prevActiveIdxForSeedRef = useRef<number | null>(activeIdx);
  // Diagnostic snapshot — published as data attributes on .sc-ab-root so
  // tests and devtools can verify that the safety margin was actually
  // applied to the running build.
  const [sizingDiag, setSizingDiag] = useState<{
    A: number;
    B: number;
    rawSize: number;
    safety: number;
    minSize: number;
  } | null>(null);

  // Live sizing config from dev settings (resolves to defaults if user
  // hasn't touched the sliders).
  const sizingCfg = useSettingsStore((s) => s.bulletSizingConfig);
  const safetyMinPx = sizingCfg?.safetyMinPx ?? MIN_SIZE_SAFETY_PX_DEFAULT;
  const safetyFraction = sizingCfg?.safetyFraction ?? MIN_SIZE_SAFETY_FRACTION_DEFAULT;
  const overflowTolerance = sizingCfg?.overflowTolerance ?? OVERFLOW_TOLERANCE_DEFAULT;
  const underflowTolerance = sizingCfg?.underflowTolerance ?? UNDERFLOW_TOLERANCE_DEFAULT;
  const maxAdjustmentIter = sizingCfg?.maxAdjustmentIter ?? MAX_ADJUSTMENT_ITER_DEFAULT;
  // User preferences for the opening paragraph: one sentence per line (default
  // on) and justify vs. left-align (default left). Independent of each other.
  const sentencePerLine = useSettingsStore((s) => s.sentencePerLine);
  const nodeFontId = useSettingsStore((s) => s.nodeFontId);
  const [nodeFontLoadEpoch, setNodeFontLoadEpoch] = useState(0);
  useEffect(() => {
    // Script subsets can finish loading after the family's first Latin face.
    // Re-measure both visible and hidden labs even if the first paragraph's
    // height stayed unchanged while the glyph widths changed.
    const loaded = () => setNodeFontLoadEpoch(epoch => epoch + 1);
    document.fonts?.addEventListener?.('loadingdone', loaded);
    return () => document.fonts?.removeEventListener?.('loadingdone', loaded);
  }, []);
  useEffect(() => {
    // The normal Atkinson font already follows the existing fontsReady gate.
    if (nodeFontId === APP_FONT_ID && !readingFamily) return;
    let cancelled = false;
    void ensureReadingFontLoaded(nodeFontId).then(() => {
      if (!cancelled) setNodeFontLoadEpoch((epoch) => epoch + 1);
    });
    return () => { cancelled = true; };
  }, [nodeFontId, readingFamily]);
  const justifyParagraph = useSettingsStore((s) => s.justifyParagraph);
  const freeTextAlign: 'justify' | 'start' = justifyParagraph ? 'justify' : 'start';
  // Per-node override of the global chunking setting: when this node sets
  // `chunkIntro`, it wins; otherwise inherit `sentencePerLine`. `perLine` gates
  // sentence-per-line at BOTH render sites below (visible + hidden clone).
  const nodeChunkIntro = useGraphStore((s) => s.project?.nodes[parentNodeId]?.chunkIntro);
  const perLine = nodeChunkIntro ?? sentencePerLine;
  const [fontsReady, setFontsReady] = useState<boolean>(() => {
    if (typeof document === 'undefined') return true;
    if (!document.fonts) return true;
    return document.fonts.status === 'loaded';
  });
  const referenceResolution = useReferenceResolution(parentNodeId);
  const activeRecords = useActiveRecords(parentNodeId);
  const currentVersionIndex = useGraphStore(
    (s) => s.project?.nodes[parentNodeId]?.currentVersionIndex,
  );
  const rewriteDraftVersionIndex = useRewriteStore(
    (s) => s.snapshot[parentNodeId]?.draftVersionIndex,
  );
  const viewingGeneratingVersion = useGraphStore((s) => {
    const node = s.project?.nodes[parentNodeId];
    return !!node?.generating
      && (node.generatingVersionIndex == null || node.generatingVersionIndex === node.currentVersionIndex);
  });
  // A real rewrite burst records the version it owns. Hide its transient
  // selection/title effects only when the user browses a different version.
  // The no-snapshot fallback keeps isolated partial-rewrite renderers and
  // tests compatible while no versioned burst is active.
  const visibleActiveRecords = rewriteDraftVersionIndex == null
    || rewriteDraftVersionIndex === currentVersionIndex
    ? activeRecords
    : undefined;
  const relations = useGraphStore((s) => nodeRelations(s.project?.arrows, parentNodeId));
  const selectedRelationChildId = useGraphStore((s) => {
    const own = nodeRelations(s.project?.arrows, parentNodeId);
    return relatedSelectedNodeId(s.project?.selection, own.sourceSelectionChildIds);
  });
  const highlightedRelationArrowId = useGraphStore((s) => (
    s.highlight?.parentNodeId === parentNodeId
      && s.highlight.arrowId
      && nodeRelations(s.project?.arrows, parentNodeId).sourceSelectionById.has(s.highlight.arrowId)
      ? s.highlight.arrowId : null
  ));
  // Resolving passage offsets parses text. Focus only changes their active
  // presentation, so keep that work cached separately from the highlight.
  const resolvedSourceSelections = useMemo(() => currentVersionCreatedAt == null ? []
    : relations.sourceSelections.flatMap(arrow => {
      const resolved = resolveArrowSourceSelection(body, currentVersionCreatedAt, arrow.sourceSelection);
      return resolved ? [{ arrow, resolved }] : [];
    }), [body, currentVersionCreatedAt, relations.sourceSelections]);
  const sourceMarksByField = useMemo<SourceMarksByField>(() => {
    const byField = new Map<string, FieldSourceMarks>();
    for (const { arrow, resolved } of resolvedSourceSelections) {
      const active = arrow.toNodeId === selectedRelationChildId
        || arrow.id === highlightedRelationArrowId;
      for (const part of resolved.parts) {
        const field = byField.get(part.sourceField) ?? { persistent: [], modifying: [] };
        field.persistent.push({
          displayStart: part.displayStart,
          displayEnd: part.displayEnd,
          arrow,
          active,
        });
        if (!byField.has(part.sourceField)) byField.set(part.sourceField, field);
      }
    }
    for (const field of byField.values()) {
      field.persistent.sort((a, b) => (
        a.arrow.sourceSelection!.createdAt - b.arrow.sourceSelection!.createdAt
        || a.arrow.id.localeCompare(b.arrow.id)
      ));
    }
    if (currentVersionCreatedAt != null && visibleActiveRecords) {
      for (const record of visibleActiveRecords) {
        if (record.kind !== 'partial' || record.target?.kind !== 'selection') continue;
        const parts = record.target.parts?.filter((part) => !!part.sourceField) ?? [];
        if (!parts.length) continue;
        const resolved = resolveArrowSourceSelection(body, currentVersionCreatedAt, {
          sourceVersionCreatedAt: currentVersionCreatedAt,
          createdAt: 0,
          text: record.originalSectionText?.replace(/\s+/g, ' ').trim() ?? '',
          parts,
        });
        if (!resolved) continue;
        for (const part of resolved.parts) {
          const field = byField.get(part.sourceField) ?? { persistent: [], modifying: [] };
          field.modifying.push({
            displayStart: part.displayStart,
            displayEnd: part.displayEnd,
          });
          if (!byField.has(part.sourceField)) byField.set(part.sourceField, field);
        }
      }
    }
    return byField;
  }, [
    visibleActiveRecords,
    body,
    currentVersionCreatedAt,
    highlightedRelationArrowId,
    resolvedSourceSelections,
    selectedRelationChildId,
  ]);
  const activeSourceOutlineKey = useMemo(() => {
    const active: string[] = [];
    for (const [field, marks] of sourceMarksByField) {
      for (const mark of marks.persistent) {
        if (mark.active) active.push(`${field}:${mark.arrow.id}:${mark.displayStart}:${mark.displayEnd}`);
      }
    }
    return active.join('|');
  }, [sourceMarksByField]);

  // Stabilized parse: parseBody mints all-new objects each call, but during a
  // streaming pass most bullets' CONTENT is unchanged frame to frame. Reusing
  // the previous objects for unchanged bullets (and the previous array when
  // no bullet changed) is what lets BulletItemInner and the lab-JSX memos
  // bail out below. Ref mutation inside useMemo is safe here: the function is
  // idempotent (stabilizing against its own output returns the same result).
  const prevParsedRef = useRef<ParsedBody | null>(null);
  const renderBody = useMemo(() => {
    if (!internalCitationSignature) return body;
    const numbers = new Set(internalCitationSignature.split(',').map(Number));
    return body.replace(/\((\d+)\)/g, (token, digits: string) => (
      numbers.has(Number(digits)) ? `⦅${digits}⦆` : token
    ));
  }, [body, internalCitationSignature]);
  const parsed = useMemo(() => {
    const stabilized = stabilizeParsed(prevParsedRef.current, parseBody(renderBody));
    prevParsedRef.current = stabilized;
    return stabilized;
  }, [renderBody]);
  const bullets: Bullet[] = useMemo(() => parsed?.bullets ?? [], [parsed]);
  const freeText = parsed?.freeText ?? renderBody.trim();

  // Average per-bullet lab measurements into a single Heights
  // tuple that approximates "typical" title / inline-add / per-
  // described-row heights across the bullets. Used by the cascade
  // SEED only — measure-correct still reads per-bullet rendered
  // heights so per-bullet variation is preserved. Returns null
  // until labs have measured (first render); seed falls back to
  // synthetic HEIGHTS in that brief window.
  const measuredHeights = useMemo<Heights | null>(() => {
    if (!labHeights || bullets.length === 0) return null;
    const { m0, m1, full } = labHeights;
    if (m0.length !== bullets.length) return null;
    let titleSum = 0;
    let inlineSum = 0;
    let inlineCount = 0;
    let describedSum = 0;
    let describedCount = 0;
    for (let i = 0; i < bullets.length; i++) {
      titleSum += m0[i] ?? 0;
      const N = bullets[i]!.children.length;
      if (N > 0) {
        const inlineGap = (m1[i] ?? 0) - (m0[i] ?? 0);
        if (inlineGap > 0) { inlineSum += inlineGap; inlineCount++; }
        const describedTotal = (full[i] ?? 0) - (m0[i] ?? 0);
        if (describedTotal > 0) { describedSum += describedTotal / N; describedCount++; }
      }
    }
    return {
      title: titleSum / bullets.length,
      inline: inlineCount > 0 ? inlineSum / inlineCount : HEIGHTS.inline,
      described: describedCount > 0 ? describedSum / describedCount : HEIGHTS.described,
    };
  }, [labHeights, bullets]);

  // Heights value used for the cascade seed. Falls back to
  // synthetic until labs have produced a measurement.
  const seedHeights: Heights = measuredHeights ?? HEIGHTS;

  // ── Tail skeleton while pass-1 text streams ─────────────────────
  // Display-only ghost bullet after the list (never rendered inside the
  // hidden labs). Its height is reserved explicitly (STREAM_SKELETON_RESERVE)
  // rather than measured, so the sizing math stays exact — see the constant.
  const isStreamingText = useGraphStore(
    (s) => !!s.project?.nodes[parentNodeId]?.streamingText,
  );
  // Also subscribed for the divider-hide rule in the render below: with the
  // bullets section chevron-hidden, the divider would sit right above the
  // footer's top border — two horizontal rules a few px apart.
  const nodeBulletsCollapsed = useGraphStore(
    (s) => !!s.project?.nodes[parentNodeId]?.bulletsCollapsed,
  );
  const showTailSkeleton = viewingGeneratingVersion && isStreamingText && !collapsed && !nodeBulletsCollapsed;
  const skelReserve = showTailSkeleton ? STREAM_SKELETON_RESERVE : 0;

  // ── Precomputed cascade states per activeIdx ───────────────────
  // For each possible value of activeIdx (null = no L1 forced
  // active, 0..N-1 = each bullet active), compute the converged
  // modes array. Uses per-bullet heights from current-width labs
  // (curLabs) so the result equals what the cascade's measure-
  // correct loop would converge to at the current width.
  //
  // Recomputed on body / containerH / freeTextH / curLabs
  // changes. Pure JS — no DOM reads at scroll time. The cascade
  // seed branch then becomes a O(1) Map.get().
  //
  // Null when curLabs hasn't measured yet; cascade seed falls
  // back to computeModes(seedHeights) in that brief window.
  const cascadeStates = useMemo<CascadeStatesLookup | null>(() => {
    if (!curLabs || curLabs.m0.length !== bullets.length) return null;
    if (containerH === 0) return null;
    const avail = Math.max(0, containerH - freeTextH - FLEX_GAP - skelReserve);
    // Delegated to the exported, unit-tested cascade precompute —
    // `computeCascadeAtActiveIdx` includes the iterative-promote
    // phase that ensures each returned state is FULLY-PROMOTED (no
    // single-step promotion of any non-active bullet would still
    // fit). Without that phase the seed could leave room on the
    // table, and the cascade's runtime measure-correct loop would
    // promote after the animation — producing the visible "collapse
    // too much then expand back" bounce.
    //
    // The LAZY lookup computes each activeIdx's state on first
    // get() (unit-tested identical to the eager table). The seed
    // reads one entry per frame, and during streaming these inputs
    // change every frame — eagerly building all N+2 states per
    // frame was ~N× wasted work.
    return createLazyCascadeStates(bullets, avail, curLabs);
  }, [bullets, containerH, freeTextH, curLabs, skelReserve]);

  // NOTE: `collapsed` is deliberately NOT part of this gate. A collapsed
  // node measures its labs invisibly at mount (the labs are absolutely
  // positioned off-screen; the collapsed body only clips by height, the
  // container keeps its width) and the latch unmounts them right after —
  // so the FIRST expand of a node is always the cheap fresh path. Gating
  // on `collapsed` deferred that measurement to the expand click itself
  // (the old premeasure path), which was the single heaviest interaction
  // in text-heavy projects.
  const hiddenLabsMeasureDisabled = deferHiddenLabs || labsDone;
  const hiddenLabsRendered = !hiddenLabsMeasureDisabled;

  // Measurements are in layout CSS pixels. offsetHeight/offsetWidth ignore
  // the canvas transform, so camera zoom does not become a measurement input.
  // getBoundingClientRect remains as a jsdom/test fallback where offsets are 0.
  // While an LLM stream is rewriting this node's body, hide the
  // chevrons-up-down expand buttons — clicking one mid-stream would
  // be confusing (the body is in flux) and the markers we'd splice
  // in might not align with the current parse.
  const isGenerating = viewingGeneratingVersion;
  const wholeRewriteBodyFloor = useRewriteStore((s) => {
    const records = s.activeByNode[parentNodeId];
    if (!records?.some((record) => record.kind === 'whole')) return null;
    return s.snapshot[parentNodeId]?.preBurstBodyHeightFloor ?? null;
  });
  const wholeRewriteSourceIndex = useRewriteStore((s) => {
    if (!s.activeByNode[parentNodeId]?.some((record) => record.kind === 'whole')) return null;
    return s.snapshot[parentNodeId]?.preBurstVersionIndex ?? null;
  });
  const wholeRewriteWidthFloor = useGraphStore((s) => {
    if (!isGenerating || wholeRewriteSourceIndex == null) return null;
    // The source version stays intact while the provisional version streams.
    // Keep its width just as we keep its height: empty/partial replacement
    // text is not evidence that the card should become narrower.
    return s.project?.nodes[parentNodeId]?.versions[wholeRewriteSourceIndex]?.width ?? DEFAULT_NODE_W;
  });
  // Advance the streaming measure tick while this node generates. The sweep
  // gates in the two measure effects below only fire on a tick-advance
  // render, so between ticks the streamed body updates cost zero lab
  // measurement (the labs stay mounted and update incrementally — see the
  // latch effect, which is suppressed while generating).
  useEffect(() => {
    if (!isGenerating) return;
    setStreamTick((t) => t + 1); // first sweep lands right at stream start
    const id = setInterval(() => setStreamTick((t) => t + 1), STREAM_MEASURE_MS);
    return () => clearInterval(id);
  }, [isGenerating]);
  // Current version's minimum width (raised by the 3:2 aspect cap). Drives
  // the width the hidden FLOOR labs measure at — so a widened version's
  // minimal height is computed at its actual min width and comes out shorter.
  // Unset → measureW = MEASURE_WIDTH. Per-version so each version measures at
  // its own min width.
  const nodeMinWidthVal = useGraphStore((s) => {
    const n = s.project?.nodes[parentNodeId];
    return n ? n.versions[n.currentVersionIndex]?.minWidth : undefined;
  });
  const measureW = measureWidthFor(nodeMinWidthVal);
  // (nodeBulletsCollapsed is subscribed further up, with the tail-skeleton
  // flags — it feeds both the skeleton gating and the divider-hide rule.)
  // While THIS node has a PARTIAL rewrite targeting the freetext in
  // flight, hold the freetext block at a small min-height (via the
  // `.is-expand-target` class) so it doesn't collapse to zero while
  // its text is chewed back and re-streamed — avoids a layout jump.
  // The generation indicator itself is the header pulse (see
  // NodeHeader); there is no longer an inline text cursor.
  const freetextTargetedByPartial = useMemo(() => {
    if (!visibleActiveRecords) return false;
    for (const r of visibleActiveRecords) {
      if (r.kind === 'partial' && r.target?.kind === 'freetext') return true;
    }
    return false;
  }, [visibleActiveRecords]);
  // L1 bullet indices currently being expand-part'd. The matching
  // bullet's title pulses (same opacity oscillation as the header) so
  // the user can see WHICH section "expand selected" is regenerating —
  // the L1 title itself isn't rewritten (only its L2 children are), so
  // it stays put and reads cleanly as a pulsing anchor.
  const bulletTargetsByPartial = useMemo(() => {
    const set = new Set<number>();
    if (!visibleActiveRecords) return set;
    for (const r of visibleActiveRecords) {
      if (r.kind === 'partial' && r.target?.kind === 'bullet') set.add(r.target.index);
    }
    return set;
  }, [visibleActiveRecords]);
  const pulseStyle = useGenerationPulseSync(
    showTailSkeleton || freetextTargetedByPartial || bulletTargetsByPartial.size > 0,
  );
  // The term-label of the arrow from THIS node to whichever child node
  // is currently selected — or null if no child of this node is the
  // single selection. Used to auto-expand the bullet that contains the
  // chip the user originally clicked to spawn that child.
  // Returns a primitive (string | null), so Zustand's Object.is bail
  // skips re-renders on every project mutation that doesn't change
  // which-of-my-children-is-focused.
  const focusedChildTerm = useGraphStore((s) => {
    const proj = s.project;
    if (!proj || proj.selection.length !== 1) return null;
    const selectedId = proj.selection[0]!;
    if (selectedId === parentNodeId) return null;
    return nodeRelations(proj.arrows, parentNodeId).firstTermByChild.get(selectedId) ?? null;
  });
  const adjustState = useRef<{
    inputKey: string;
    iter: number;
    overflowSeen: boolean;
    // Bullet we promoted on the previous iteration, or -1. When the
    // measurement loop next sees an overflow we revert THIS specific
    // bullet (rather than demoting the bottom-most highest-mode bullet)
    // and add it to `skip` so we don't retry it. That lets the cascade
    // promote cheaper bullets even when the topmost-lowest-mode bullet
    // would overflow — exactly the "expand short descriptions while
    // leaving long ones collapsed" behavior.
    lastPromoted: number;
    skip: Set<number>;
  }>({
    inputKey: '',
    iter: 0,
    overflowSeen: false,
    lastPromoted: -1,
    skip: new Set(),
  });
  /** Set when the measure-correct loop last ran to completion WITHOUT
   *  adjusting (converged), recording exactly the inputs that determined that
   *  outcome. While they're all unchanged, re-running the loop would force
   *  layout (N getBoundingClientRect reads) only to do nothing — so it's
   *  skipped. Cleared whenever a measuring pass actually starts; re-set only
   *  on converged outcomes. `body`/`modes` are compared by reference (both
   *  are immutable here, so identity ⇔ unchanged). */
  const measureSkipRef = useRef<{ key: string; body: string; modes: Mode[] } | null>(null);
  // seedHeights (measured-or-fallback) included so the cascade
  // re-seeds when labs arrive (measuredHeights starts null →
  // seedHeights = synthetic HEIGHTS; once labs measure →
  // seedHeights = measured values → re-seed with accurate
  // estimates → measure-correct converges in 0-1 iterations).
  const inputKey = `${body.length}|${activeIdx}|${containerH}|${containerW}|${freeTextH}|${bullets.length}|${skelReserve}|${nodeFontId}|${nodeFontLoadEpoch}|${seedHeights.title.toFixed(1)}|${seedHeights.inline.toFixed(1)}|${seedHeights.described.toFixed(1)}`;

  // Wait for web fonts before trusting any measurement. The body font
  // (Atkinson Hyperlegible) is loaded with display: swap — measuring
  // across the swap moment gives mismatched perBullet heights and a
  // wrong minBodyHeight.
  useEffect(() => {
    if (fontsReady) return;
    if (typeof document === 'undefined') return;
    let cancelled = false;
    document.fonts?.ready?.then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => { cancelled = true; };
  }, [fontsReady]);

  useLayoutEffect(() => {
    const measure = () => {
      const c = containerRef.current;
      const ft = freeTextRef.current;
      if (c) {
        setContainerH(Math.round(layoutHeight(c)));
        setContainerW(Math.round(layoutWidth(c)));
      }
      setFreeTextH(ft ? Math.round(layoutHeight(ft)) : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    if (freeTextRef.current) ro.observe(freeTextRef.current);
    return () => ro.disconnect();
  }, [body]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While the reading ruler is on, Esc belongs to it (page.tsx exits the
      // ruler and consumes the key) — collapsing the active bullet here too
      // would yank the section out from under the ruler in the same press.
      if (useReadingStore.getState().nodeId) return;
      if (e.key === 'Escape' && activeIdx !== null) setActiveIdx(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIdx]);

  // Propagate the measured freetext height to the outer node so the
  // chevron toggle in node-footer knows how short to make the body
  // when bullets are collapsed. Skip the initial 0 so we don't
  // collapse to 18px-of-empty-space before the first measurement.
  //
  // useLayoutEffect (NOT useEffect) is important: the measurement
  // above also runs in useLayoutEffect, so freeTextH is set
  // synchronously before paint. If THIS propagation used plain
  // useEffect, NodeView wouldn't see the new freeTextH until after
  // the first paint — and a node loaded with bulletsCollapsed=true
  // would briefly show its expanded body before snapping (with the
  // 0.25 s `transition: height` it would *animate* shut, very
  // visibly) to the collapsed height once the value finally
  // arrived. Synchronous propagation closes the loop within the
  // same commit cycle so the first paint already has the right
  // body height.
  useLayoutEffect(() => {
    if (freeTextH > 0 && onFreeTextH) onFreeTextH(freeTextH);
  }, [freeTextH, onFreeTextH]);

  // "What should activeIdx be?" effect. The ONLY automatic action is the
  // expand-on-back-reference: when a child of this node becomes focused and
  // the chip that spawned it lives in a bullet, expand that bullet so the
  // user sees where they came from.
  //
  // We deliberately do NOT auto-collapse when focus moves away. The expanded
  // bullet persists when this node — or the chip-spawned child — loses focus.
  // Collapsing stays fully user-driven (Esc, re-clicking the active bullet,
  // or clicking free-text — see the handlers below).
  const focusedChildBulletIdx = useMemo(
    () => focusedChildTerm
      ? findBulletIdxContainingTerm(bullets, focusedChildTerm)
      : null,
    [focusedChildTerm, bullets],
  );
  useEffect(() => {
    if (focusedChildBulletIdx !== null) setActiveIdx(focusedChildBulletIdx);
    // else: preserve the current activeIdx — no auto-collapse on unfocus.
  }, [focusedChildBulletIdx]);

  // ─── minBodyHeight from hidden measurement lists ────────────────────
  // Reads perBulletFull / perBulletM0 / perBulletM1 from the three hidden
  // <ul>s and updates the store. Runs whenever container width / freetext
  // height / fonts / body change — all the inputs that affect text
  // wrapping. The hidden lists themselves never change their per-bullet
  // modes, so they always reflect the right heights for the current width.
  useLayoutEffect(() => {
    floorLabsStableRef.current = false;
    if (hiddenLabsMeasureDisabled) return;
    if (bullets.length === 0) return;
    if (containerW === 0) return;
    if (!fontsReady) return;
    // Streaming sweep gate: while generating, sweep only on a tick-advance
    // render, and only if the measured inputs changed since the last sweep.
    if (isGenerating) {
      const advanced = floorSeenTickRef.current !== streamTick;
      floorSeenTickRef.current = streamTick;
      if (!advanced) return;
      const swept = floorSweptRef.current;
      // skelReserve is a swept input: pass-1 ending flips it 62→0 and the
      // reserved strip must be returned on the next tick, not at stream end.
      if (swept && swept.body === body && swept.w === containerW && swept.r === skelReserve) return;
      floorSweptRef.current = { body, w: containerW, r: skelReserve };
    }

    const fullUl = hiddenFullRef.current;
    const m0Ul = hiddenM0Ref.current;
    const m1Ul = hiddenM1Ref.current;
    if (!fullUl || !m0Ul || !m1Ul) return;
    const fullItems = fullUl.querySelectorAll<HTMLElement>(':scope > .sc-ab-item');
    const m0Items = m0Ul.querySelectorAll<HTMLElement>(':scope > .sc-ab-item');
    const m1Items = m1Ul.querySelectorAll<HTMLElement>(':scope > .sc-ab-item');
    if (
      fullItems.length !== bullets.length ||
      m0Items.length !== bullets.length ||
      m1Items.length !== bullets.length
    ) {
      return;
    }

    const perBulletFull = Array.from(fullItems).map((it) => Math.round(layoutHeight(it)));
    const perBulletM0 = Array.from(m0Items).map((it) => Math.round(layoutHeight(it)));
    const perBulletM1 = Array.from(m1Items).map((it) => Math.round(layoutHeight(it)));

    // Mirror lab measurements into state for `measuredHeights`
    // (used by the cascade SEED). Guarded with arrEq so re-runs
    // of this effect produce stable state when values haven't
    // actually changed — avoids spurious re-renders.
    setLabHeights((prev) => {
      if (
        prev
        && arrEq(prev.m0, perBulletM0)
        && arrEq(prev.m1, perBulletM1)
        && arrEq(prev.full, perBulletFull)
      ) return prev;
      return { m0: [...perBulletM0], m1: [...perBulletM1], full: [...perBulletFull] };
    });

    const sumM0 = perBulletM0.reduce((s, h) => s + h, 0);
    const sumFull = perBulletFull.reduce((s, h) => s + h, 0);
    let A = 0;
    for (let i = 0; i < perBulletFull.length; i++) {
      const candidate = (perBulletFull[i] ?? 0) + (sumM0 - (perBulletM0[i] ?? 0));
      if (candidate > A) A = candidate;
    }
    const B = perBulletM1.reduce((s, h) => s + h, 0);
    const baseSize = Math.max(A, B);

    // CRUCIAL: use the freetext height as measured at MEASURE_WIDTH, NOT
    // the visible freetext at the current container width. The bullets
    // are measured at MEASURE_WIDTH (narrow worst case); if we mix in
    // the visible freetext (typically wider, so wraps less, so shorter),
    // the floor underestimates by however many extra lines the freetext
    // wraps at the narrow width. After the user widens then shrinks
    // back, the visible freetext re-wraps and minH grows — the exact
    // symptom the user reported. We use the bigger of the two as a
    // belt-and-suspenders against any width discrepancy.
    const hiddenFreeTextEl = hiddenFreeTextRef.current;
    const hiddenFreeTextH = hiddenFreeTextEl
      ? Math.round(layoutHeight(hiddenFreeTextEl))
      : freeTextH;
    // R6.2 — use the HIDDEN free-text lab (measured at MEASURE_WIDTH,
    // the narrowest allowed node width = worst-case wrap) as the floor
    // input. We deliberately do NOT max() with the VISIBLE freeTextH:
    // the visible measurement is transiently tall during the unsettled
    // mount layout (e.g. 25px before settling to 19px), and feeding
    // that transient into the floor made minSize bistable (173↔179) on
    // every reload — which flipped bodyMaxHeight → renderedHeight →
    // a physics size-kick (the "nudge") and an animated body resize
    // (the ~1-in-10 "expand/contract"). The hidden lab is at the
    // narrowest width, so it already wraps to AT LEAST as many lines as
    // the visible free-text at any actual (wider-or-equal) width — it
    // is the correct conservative floor on its own, and it is stable.
    const effectiveFreeTextH = hiddenFreeTextH;

    // Raw fit = exactly what the strict A/B math says fits. Safety is a
    // FRACTION of the entire raw size (not just the bullet area) so the
    // 20% margin the user observed corresponds to a 20% bigger body
    // overall — not 20% of A alone, which gets diluted by freetext and
    // padding into a much smaller effective margin.
    const rawSize = baseSize + effectiveFreeTextH + BODY_OVERHEAD;
    const safety = Math.max(safetyMinPx, Math.ceil(rawSize * safetyFraction));
    const minSize = Math.ceil(rawSize + safety);
    // Body height at which the cascade can show every bullet at maxMode.
    // NodeBody uses this as the exact "scrollbar has nothing to navigate"
    // threshold (replacing the older 1.45× minBodyHeight proxy that hid
    // the scrollbar too early). No safety margin — once the strict A/B/
    // C math says all bullets fit, the visible cascade fits them too.
    const fullSize = Math.ceil(sumFull + effectiveFreeTextH + BODY_OVERHEAD);

    // Publish the math as data attributes on .sc-ab-root (see render
    // below) so tests and devtools can verify the running build actually
    // applied the safety margin. Also log to console for filtering.
    setSizingDiag({ A: Math.round(A), B: Math.round(B), rawSize: Math.round(rawSize), safety, minSize });
    if (SIZING_LOG && typeof console !== 'undefined' && console.log) {
      console.log(
        `[sc-ab v7] node=${parentNodeId.slice(0, 8)} A=${A.toFixed(0)} B=${B.toFixed(0)} base=${baseSize.toFixed(0)} freetext=${effectiveFreeTextH} raw=${rawSize.toFixed(0)} safety=${safety} minSize=${minSize}`,
      );
    }

    const node = useGraphStore.getState().project?.nodes[parentNodeId];
    const ver = node?.versions[node.currentVersionIndex];
    if (!node || !ver) return;
    // R6.A3 — ±2 px tolerance. Real content/width changes move these
    // values by far more than 2 px, while font/rendering jitter may not.
    const TOL = 2;
    const oldMinW = ver.minWidth ?? MIN_NODE_W;
    const oldMinBody = ver.minBodyHeight;
    const curWidth = ver.width ?? DEFAULT_NODE_W;
    const curBody = ver.bodyMaxHeight;

    const minChanged = ver.minBodyHeight == null || Math.abs(ver.minBodyHeight - minSize) > TOL;
    const fullChanged = ver.fullBodyHeight == null || Math.abs(ver.fullBodyHeight - fullSize) > TOL;

    // 3:2 aspect cap — recomputed on EVERY measurement (i.e. any text change),
    // so editing / expanding / modifying re-balances the version, not just the
    // first generation. `fixedPx` is the portion of minSize that doesn't
    // reflow with width. Bidirectional, with hysteresis on shrink so a small
    // estimate error can't bounce the width between two rungs.
    const fixedPx = effectiveFreeTextH + BODY_OVERHEAD + safety;
    const loose = widthForAspectCap({ minBodyH: minSize, measuredContentW: measureW, fixedPx });
    let targetMinW: number;
    if (loose >= oldMinW) {
      targetMinW = loose; // grow (or stay)
    } else {
      const strict = widthForAspectCap({ minBodyH: minSize, measuredContentW: measureW, fixedPx, ratio: ASPECT_MAX_RATIO / 1.12 });
      targetMinW = Math.min(oldMinW, strict); // shrink only when comfortably safe
    }

    const updates: {
      bodyMaxHeight?: number; minBodyHeight?: number; fullBodyHeight?: number;
      width?: number; minWidth?: number; expandedMeasureWidth?: number;
    } = {};
    if (minChanged) updates.minBodyHeight = minSize;
    if (fullChanged) updates.fullBodyHeight = fullSize;
    if (Math.abs(targetMinW - oldMinW) > 1) updates.minWidth = targetMinW;
    if (ver.expandedMeasureWidth == null || Math.abs(ver.expandedMeasureWidth - curWidth) > 1) {
      updates.expandedMeasureWidth = curWidth;
    }

    // Width: track the aspect target when the version is auto-sized (sitting at
    // its min width) or while generating; otherwise just floor a manually-
    // widened version up so it can never be narrower than its min.
    const widthAtMin = ver.width == null || Math.abs(curWidth - oldMinW) <= TOL;
    const widthTarget = Math.max(targetMinW, wholeRewriteWidthFloor ?? 0);
    if (isGenerating || widthAtMin) {
      if (Math.abs(curWidth - widthTarget) > 1) updates.width = widthTarget;
    } else if (curWidth < targetMinW) {
      updates.width = targetMinW;
    }

    // Height: track the target when auto-sized (at min) or generating; else
    // grow-only floor (preserve a manual enlargement, lift it if now too small).
    // While the tail skeleton shows, the target carries its reserve so the
    // ghost bullet gets its own strip below the list; the persisted floors
    // (minBodyHeight/fullBodyHeight above) stay content-only. A cap equal to
    // the old floor PLUS the reserve is auto-sized too, not a manual resize —
    // without that clause an aborted generation would strand the cap 62px
    // tall (read as a user enlargement by the grow-only branch).
    const bodyTarget = Math.max(
      minSize + skelReserve,
      wholeRewriteBodyFloor ?? 0,
    );
    const heightAtMin = curBody == null || (oldMinBody != null && (
      Math.abs(curBody - oldMinBody) <= TOL
      || Math.abs(curBody - (oldMinBody + STREAM_SKELETON_RESERVE)) <= TOL
    ));
    if (isGenerating || heightAtMin) {
      if (curBody == null || Math.abs(curBody - bodyTarget) > TOL) updates.bodyMaxHeight = bodyTarget;
    } else if (curBody == null || curBody < minSize - TOL) {
      updates.bodyMaxHeight = minSize;
    }

    if (Object.keys(updates).length === 0) {
      // Nothing left to commit — the persisted floor sizes match this
      // measurement. Half of the labs-done condition (see latch below).
      floorLabsStableRef.current = true;
      return;
    }

    useGraphStore.temporal.getState().pause();
    try {
      useGraphStore.getState().setVersionSize(parentNodeId, updates);
    } finally {
      useGraphStore.temporal.getState().resume();
    }
    setMeasureEpoch((e) => e + 1);
  }, [hiddenLabsMeasureDisabled, containerW, freeTextH, body, fontsReady, nodeFontId, nodeFontLoadEpoch, parentNodeId, bullets, isGenerating, nodeMinWidthVal, measureW, measureEpoch, streamTick, skelReserve, wholeRewriteBodyFloor, wholeRewriteWidthFloor]);

  // ── Measure current-width labs ──────────────────────────────────
  // Mirror per-bullet M0/M1/M_max from the SECOND set of hidden labs
  // (rendered at width=containerW). Feeds `cascadeStates` which
  // precomputes converged modes per activeIdx. arrEq guard avoids
  // spurious state updates when measurements are identical.
  useLayoutEffect(() => {
    curLabsStableRef.current = false;
    if (hiddenLabsMeasureDisabled) return;
    if (bullets.length === 0) return;
    if (containerW === 0) return;
    if (!fontsReady) return;
    // Streaming sweep gate — same contract as the floor effect above.
    if (isGenerating) {
      const advanced = curSeenTickRef.current !== streamTick;
      curSeenTickRef.current = streamTick;
      if (!advanced) return;
      const swept = curSweptRef.current;
      if (swept && swept.body === body && swept.w === containerW) return;
      curSweptRef.current = { body, w: containerW };
    }

    const fullUl = hiddenCurFullRef.current;
    const m0Ul = hiddenCurM0Ref.current;
    const m1Ul = hiddenCurM1Ref.current;
    if (!fullUl || !m0Ul || !m1Ul) return;
    const fullItems = fullUl.querySelectorAll<HTMLElement>(':scope > .sc-ab-item');
    const m0Items = m0Ul.querySelectorAll<HTMLElement>(':scope > .sc-ab-item');
    const m1Items = m1Ul.querySelectorAll<HTMLElement>(':scope > .sc-ab-item');
    if (
      fullItems.length !== bullets.length
      || m0Items.length !== bullets.length
      || m1Items.length !== bullets.length
    ) return;

    const perFull = Array.from(fullItems).map((it) => Math.round(layoutHeight(it)));
    const perM0 = Array.from(m0Items).map((it) => Math.round(layoutHeight(it)));
    const perM1 = Array.from(m1Items).map((it) => Math.round(layoutHeight(it)));

    // Stability check against the render-time mirror (NOT a functional set —
    // the latch below needs to know synchronously whether this measurement
    // matched the committed one).
    const prev = curLabsRef.current;
    if (
      prev
      && arrEq(prev.m0, perM0)
      && arrEq(prev.m1, perM1)
      && arrEq(prev.full, perFull)
    ) {
      curLabsStableRef.current = true;
      return;
    }
    setCurLabs({ m0: [...perM0], m1: [...perM1], full: [...perFull] });
    setMeasureEpoch((e) => e + 1);
    // `isGenerating` MUST be a dep: the generating→false flip changes no other
    // dep (the body is already final), and without a re-run here the stable
    // flag never sets, the latch starves, and the labs stay mounted forever.
  }, [hiddenLabsMeasureDisabled, containerW, body, fontsReady, nodeFontId, nodeFontLoadEpoch, bullets, measureEpoch, streamTick, isGenerating]);

  // ── Lab lifecycle: reset + latch ────────────────────────────────
  // Reset: any input that changes text wrapping (and therefore invalidates
  // the measurements) brings the labs back for one remeasure cycle. Deps are
  // the wrap-relevant subset of the measure effects' own deps; freeTextH is
  // deliberately absent (the floor uses the HIDDEN freetext lab, so visible
  // freetext jitter must not churn the labs — see the R6.2 note above).
  useLayoutEffect(() => {
    setLabsDone(false);
  }, [body, containerW, fontsReady, nodeFontId, nodeFontLoadEpoch, nodeMinWidthVal, measureW]);
  // Latch: no deps — re-checks after every commit (same pattern as the
  // cascade loop), but it's two boolean reads. Both measure effects ran
  // earlier in this same commit, so the flags reflect the labs as currently
  // rendered; when both passes found nothing to change, the labs have done
  // their job and unmount until the next reset.
  useLayoutEffect(() => {
    // While generating, the labs stay mounted for the whole stream: latching
    // here would tear down and rebuild ~6× the body DOM on every sweep. The
    // generating→false flip re-runs both measure effects (it's in their
    // deps), they converge on the final body, and THEN this latch fires.
    if (isGenerating) return;
    if (hiddenLabsMeasureDisabled || bullets.length === 0) return;
    if (floorLabsStableRef.current && curLabsStableRef.current) setLabsDone(true);
  });

  // ─── Cascade: uniform-first seed + measure-correct loop ─────────
  // This is the ORIGINAL working cascade — restored after the
  // approach-a-v4 experiment proved unworkable in production
  // (worst-case measured heights at MIN_NODE_W produced empty
  // space at wider widths and clipped bullets at narrower widths
  // because the cascade was deciding modes based on averaged
  // measurements that didn't match per-bullet reality).
  //
  // How it works:
  //   1. SEED on every inputKey change. Uses synthetic HEIGHTS
  //      as a starting estimate. computeModes picks modes that
  //      fit `avail` according to those estimates.
  //   2. MEASURE-CORRECT on subsequent renders. Reads each
  //      bullet's ACTUAL rendered height (at the current width,
  //      not worst-case) in layout CSS pixels. If the sum
  //      overflows, demote the lastPromoted (or the bottom-most
  //      highest-mode). If it underflows AND we never saw an
  //      overflow, promote the topmost-lowest-mode bullet.
  //   3. The loop terminates when modes are stable (no further
  //      promote/demote fits) or maxAdjustmentIter is hit.
  //
  // Bullets size NATURALLY to their content — no inline style.height.
  // That's why content-width changes (node resize) just work:
  // bullets re-wrap, the cascade observes new heights, re-allocates.
  //
  // The seed primarily uses `cascadeStates.get(activeIdx)` — a
  // Map of converged modes precomputed from per-bullet labs at
  // the current width. When that's available the seed equals
  // what measure-correct would converge to → measure-correct
  // usually has nothing to iterate on. Snappy.
  useLayoutEffect(() => {
    if (collapsed) return;
    if (bullets.length === 0) {
      if (modes.length !== 0) setModes([]);
      return;
    }
    if (containerH === 0) return;

    if (adjustState.current.inputKey !== inputKey) {
      measureSkipRef.current = null;
      adjustState.current = {
        inputKey, iter: 0, overflowSeen: false,
        lastPromoted: -1, skip: new Set(),
      };
      const avail = Math.max(0, containerH - freeTextH - FLEX_GAP - skelReserve);

      // SWAP-SEED OPTIMIZATION
      // ─────────────────────────────────────────────────────────
      // When the user scrolls between two L1 bullets (the
      // overwhelmingly common case), the only thing that
      // semantically changed is WHICH bullet is at Mmax. The
      // previous converged modes already satisfied the avail
      // constraint at the current width; we can preserve them
      // by SWAPPING the Mmax assignment:
      //   - new active bullet → Mmax
      //   - old active bullet → the mode the new active had
      //
      // Result has the SAME total formal height as the previous
      // state, so measure-correct converges in 0 iterations —
      // no post-animation chatter ("expand a little then
      // collapse" disappears).
      //
      // Applies only when both old and new active are non-null
      // and the bullets array is unchanged. For other cases
      // (active → null, null → active, body re-parsed, width
      // resized) fall through to the full computeModes seed —
      // those transitions can't be solved by a simple swap.
      const prevActive = prevActiveIdxForSeedRef.current;
      const canSwap = (
        activeIdx !== null
        && prevActive !== null
        && prevActive !== activeIdx
        && modes.length === bullets.length
        && activeIdx >= 0
        && activeIdx < bullets.length
        && prevActive >= 0
        && prevActive < bullets.length
      );

      let seed: Mode[];
      // PRIMARY PATH: precomputed cascade state lookup.
      // cascadeStates is a Map<activeIdx, Mode[]> built using
      // per-bullet labs measured AT THE CURRENT containerW. The
      // map's value for `activeIdx` IS the converged state at
      // current width — so measure-correct finds nothing to do
      // post-animation. All mode changes land in one setModes,
      // animation transitions everything simultaneously, butter
      // smooth.
      const cachedSeed = cascadeStates ? cascadeStates.get(activeIdx) : undefined;
      if (cachedSeed) {
        seed = cachedSeed.slice();
      } else if (canSwap) {
        // FALLBACK: swap-seed + fill/trim. Used in the brief
        // window before current-width labs first measure (first
        // render or right after body change).
        seed = [...modes];
        // Clamp to prevActive's own maxMode in case bullets[prevActive]
        // has fewer children than bullets[activeIdx] — otherwise we
        // could assign a mode that exceeds the bullet's actual max
        // (e.g. activeIdx has 5 children and was at Mmax=6 via the
        // cascade's free-upgrade sweep; prevActive only has 2 children
        // with maxMode=3; assigning 6 would be invalid).
        const oldModeAtNewIdx = Math.min(
          seed[activeIdx] ?? 0,
          maxMode(bullets[prevActive]!),
        );
        seed[activeIdx] = maxMode(bullets[activeIdx]!);
        seed[prevActive] = oldModeAtNewIdx;

        // ── FILL / TRIM to avail ─────────────────────────────────
        // Swap-seed preserves total height ONLY when both bullets
        // share the same child count. For asymmetric bullets
        // (e.g. b0 has 5 children, b1 has 2), swapping Mmax
        // between them changes the total — leaving the cascade
        // with under- or over-fit that measure-correct would
        // resolve via post-animation snaps (the visible "lag"
        // the user reported).
        //
        // Run a JS greedy fill/trim against `avail` now (using
        // seedHeights), so the seed already accounts for the
        // discrepancy. All mode changes land in ONE setModes
        // call → animation transitions everything simultaneously
        // → no post-animation snap.
        const totalAt = (m: Mode[]): number => {
          let s = 0;
          for (let i = 0; i < m.length; i++) {
            s += heightOf(bullets[i]!, m[i] ?? 0, seedHeights);
          }
          return s;
        };
        let total = totalAt(seed);
        // GREEDY PROMOTE: lowest-mode non-active bullet that can
        // be promoted without overflowing. Repeats until no
        // promotion fits. Active bullet stays at Mmax.
        let prog = true;
        while (prog) {
          prog = false;
          let pickIdx = -1;
          let pickCur = Infinity;
          for (let i = 0; i < seed.length; i++) {
            if (i === activeIdx) continue;
            const b = bullets[i]!;
            const cur = seed[i] ?? 0;
            if (cur >= maxMode(b)) continue;
            const delta = heightOf(b, cur + 1, seedHeights)
              - heightOf(b, cur, seedHeights);
            if (total + delta > avail) continue;
            if (cur < pickCur) { pickCur = cur; pickIdx = i; }
          }
          if (pickIdx >= 0) {
            seed[pickIdx] = (seed[pickIdx] ?? 0) + 1;
            total = totalAt(seed);
            prog = true;
          }
        }
        // GREEDY TRIM: if swap-seed was already over avail
        // (rare — asymmetric where new active is bigger than old),
        // demote bottom-most highest-mode non-active until fits.
        // Active bullet always stays at Mmax.
        while (total > avail) {
          let pickIdx = -1;
          let pickCur = -1;
          for (let i = seed.length - 1; i >= 0; i--) {
            if (i === activeIdx) continue;
            const cur = seed[i] ?? 0;
            if (cur === 0) continue;
            if (cur > pickCur) { pickCur = cur; pickIdx = i; }
          }
          if (pickIdx === -1) break;
          seed[pickIdx] = (seed[pickIdx] ?? 0) - 1;
          total = totalAt(seed);
        }
      } else {
        // Use seedHeights (lab-measured-or-fallback) so the
        // computed seed is as close to the converged state as
        // labs-at-MIN_NODE_W allow. Still slightly conservative
        // at wider widths (labs over-estimate heights vs current
        // wider width), but better than synthetic.
        seed = computeModes(bullets, activeIdx, avail, seedHeights);
      }

      if (!arrEq(modes, seed)) {
        setModes(seed);
      }
      prevActiveIdxForSeedRef.current = activeIdx;
      return;
    }

    // Everything that can change rendered item heights or the decision
    // thresholds, for THIS render. inputKey already covers body length /
    // activeIdx / container / freetext / bullet count / seed heights; the
    // rest are the remaining height-relevant inputs this component observes
    // (skeleton rows, chunking, alignment, fonts, tolerances).
    const measureKey = [
      inputKey,
      [...bulletTargetsByPartial].sort((a, b) => a - b).join(','),
      freetextTargetedByPartial,
      focusedChildTerm ?? '',
      perLine,
      freeTextAlign,
      nodeBulletsCollapsed,
      fontsReady,
      isGenerating,
      overflowTolerance,
      underflowTolerance,
      maxAdjustmentIter,
    ].join('|');
    const skip = measureSkipRef.current;
    if (skip && skip.key === measureKey && skip.body === body && skip.modes === modes) {
      // Converged and provably nothing height-relevant changed since —
      // re-reading N item heights would force layout and change nothing.
      return;
    }
    measureSkipRef.current = null;
    const markConverged = () => {
      measureSkipRef.current = { key: measureKey, body, modes };
    };

    const ul = visibleListRef.current;
    if (!ul) return;
    const items = ul.querySelectorAll<HTMLElement>(':scope > .sc-ab-item');
    if (items.length === 0) return;

    let sumMeasured = 0;
    for (const it of items) sumMeasured += layoutHeight(it);
    const avail = Math.max(0, containerH - freeTextH - FLEX_GAP - skelReserve);

    if (adjustState.current.iter >= maxAdjustmentIter) {
      // Iteration cap: the loop stops adjusting for this inputKey either
      // way — recording convergence just stops the now-pointless re-reads.
      markConverged();
      return;
    }
    adjustState.current.iter++;

    if (sumMeasured > avail + overflowTolerance) {
      // Two flavors of overflow:
      //  (a) The previous iteration just promoted a specific bullet —
      //      blame THAT bullet, revert it, and add it to `skip` so the
      //      loop keeps trying cheaper candidates.
      //  (b) No recent promotion (so the seed itself overflows) — fall
      //      back to the original "demote bottom-most highest-mode"
      //      strategy and latch overflowSeen to stop ever promoting
      //      again, which prevents oscillation when the seed is just
      //      too tall.
      if (adjustState.current.lastPromoted >= 0) {
        const bi = adjustState.current.lastPromoted;
        adjustState.current.skip.add(bi);
        adjustState.current.lastPromoted = -1;
        setModes((prev) => {
          const next = [...prev];
          next[bi] = Math.max(0, (next[bi] ?? 0) - 1);
          return next;
        });
      } else {
        adjustState.current.overflowSeen = true;
        setModes((prev) => {
          const next = [...prev];
          let highest = -1;
          let pickIdx = -1;
          for (let i = next.length - 1; i >= 0; i--) {
            if (i === activeIdx) continue;
            const cur = next[i] ?? 0;
            if (cur === 0) continue;
            if (cur > highest) {
              highest = cur;
              pickIdx = i;
            }
          }
          if (pickIdx === -1) return prev;
          next[pickIdx] = (next[pickIdx] ?? 0) - 1;
          return next;
        });
      }
    } else if (
      sumMeasured < avail - underflowTolerance &&
      !adjustState.current.overflowSeen
    ) {
      // Promote: top-most non-active bullet at the lowest current mode
      // that hasn't already been proven too expensive.
      let lowest = Infinity;
      let pickIdx = -1;
      for (let i = 0; i < modes.length; i++) {
        if (i === activeIdx) continue;
        if (adjustState.current.skip.has(i)) continue;
        const cur = modes[i] ?? 0;
        const max = maxMode(bullets[i]!);
        if (cur >= max) continue;
        if (cur < lowest) {
          lowest = cur;
          pickIdx = i;
        }
      }
      if (pickIdx === -1) {
        markConverged(); // nothing left to promote — the state is final
        return;
      }
      adjustState.current.lastPromoted = pickIdx;
      const captured = pickIdx;
      setModes((prev) => {
        const next = [...prev];
        next[captured] = (next[captured] ?? 0) + 1;
        return next;
      });
    } else {
      // Within tolerances (or underflow with overflowSeen latched, which
      // never promotes again) — the loop is done for these inputs.
      markConverged();
    }
  });

  const handleBulletClick = (i: number) => (e: ReactMouseEvent) => {
    // If the user just finished selecting body text, the mouseup fires a
    // click — don't let it toggle the bullet. A plain click collapses the
    // selection before the click fires, so ordinary clicks still pass.
    if (!window.getSelection()?.isCollapsed) return;
    const t = e.target as HTMLElement;
    if (t.closest('.ref-chip, .cite-marker, a, button')) return;
    // Intentionally NOT stopping propagation: the click bubbles up to
    // NodeView's onClick, which handles "focus this node" (selection
    // + minimum-pan). Bubbling means we only need to maintain the
    // focus orchestration in ONE place (NodeView), not duplicate it
    // here. NodeView's `if (!p.selected) p.onSelect()` guard prevents
    // an already-focused node from re-panning on subsequent clicks.
    //
    // Clicking an already-ACTIVE bullet is a no-op: it must NOT collapse.
    // Collapsing re-seeded the cascade and reset the scroll position to the
    // top (the reported bug). A bullet that already fits fully can still become
    // active, so its highlight and scrollbar position follow the user's intent.
    // Collapse is still available via Esc or clicking the opening paragraph.
    if (activeIdx === i) return;
    setActiveIdx(i);
  };

  const handleBulletKey = (i: number) => (e: ReactKeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    // Same rationale as handleBulletClick — let it bubble so the node
    // focuses via NodeView's keyboard equivalent (if any) / its click
    // handler synthesized by the browser for Enter on role=button.
    // Already-active → no-op; fully visible but inactive bullets still activate.
    if (activeIdx === i) return;
    setActiveIdx(i);
  };

  // PERF R4: Memoize the hidden measurement lab JSX so it ISN'T
  // re-rendered on every parent re-render (i.e. every physics tick).
  // The lab exists purely to give the measurement effect three
  // position-stable DOM subtrees to read getBoundingClientRect on —
  // its CONTENT only changes when the body text or the parent node id
  // changes. By memoizing, React's reconciler bails out of these three
  // sub-lists on every re-render that doesn't change those inputs.
  //
  // Saves ~32 bullet-item renders per node per tick (8 visible + 8×3
  // hidden, minus the visible 8 that still need to render at varying
  // modes). For a 10-node graph during a drag (~60 ticks/sec) that's
  // 32 × 10 × 60 = ~19 200 list-item renders/sec eliminated.
  //
  // Deps:
  //   - `bullets` is itself useMemo'd on the parsed body, so it only
  //     changes when `body` does.
  //   - `freeText` is a substring of body; changes with body.
  //   - `parentNodeId` is stable for the lifetime of the node.
  //   - `onReferenceClick` is stabilized in NodeBody via useCallback([]).
  // Refs (hiddenFreeTextRef, hiddenFullRef, hiddenM0Ref, hiddenM1Ref)
  // remain attached to the same DOM nodes across the memo cache hit —
  // React preserves refs when it bails out of a subtree.
  const hiddenLabJsx = useMemo(() => {
    if (!hiddenLabsRendered) return null;
    if (bullets.length === 0) return null;
    return (
      <div
        className="sc-ab-measure"
        aria-hidden="true"
        style={{ width: measureW }}
      >
        {freeText && (
          <div ref={hiddenFreeTextRef} className="sc-ab-freetext" data-sc-source-field="ft" style={{ textAlign: freeTextAlign }}>
            {renderFreeText(freeText, parentNodeId, onReferenceClick, perLine, referenceResolution, sourceMarksByField.get('ft'))}
          </div>
        )}
        <ul className="sc-ab-list" ref={hiddenFullRef}>
          {bullets.map((b, i) => (
            <li key={`f${i}`} className="sc-ab-item is-active">
              <BulletItemInner b={b} m={maxMode(b)} parentNodeId={parentNodeId} onRef={onReferenceClick} resolution={referenceResolution} bulletIndex={i} sourceMarks={sourceMarksByField} />
            </li>
          ))}
        </ul>
        <ul className="sc-ab-list" ref={hiddenM0Ref}>
          {bullets.map((b, i) => (
            <li key={`z${i}`} className="sc-ab-item">
              <BulletItemInner b={b} m={0} parentNodeId={parentNodeId} onRef={onReferenceClick} resolution={referenceResolution} bulletIndex={i} sourceMarks={sourceMarksByField} />
            </li>
          ))}
        </ul>
        <ul className="sc-ab-list" ref={hiddenM1Ref}>
          {bullets.map((b, i) => (
            <li key={`o${i}`} className="sc-ab-item">
              <BulletItemInner b={b} m={Math.min(1, maxMode(b))} parentNodeId={parentNodeId} onRef={onReferenceClick} resolution={referenceResolution} bulletIndex={i} sourceMarks={sourceMarksByField} />
            </li>
          ))}
        </ul>
      </div>
    );
  }, [hiddenLabsRendered, bullets, freeText, parentNodeId, onReferenceClick, measureW, perLine, freeTextAlign, referenceResolution, sourceMarksByField]);

  // ── Current-width labs (second set) ───────────────────────────
  // Mirrors the structure of the worst-case labs above but rendered
  // at width=containerW. Used by cascadeStates to precompute exact
  // converged modes for the current width. Width prop changes when
  // user resizes node → React re-renders these labs at new width
  // → ResizeObserver / useLayoutEffect re-measure → curLabs state
  // updates → cascadeStates recomputes. No freetext lab here (the
  // visible freetext is already at containerW; its measured height
  // is in `freeTextH`).
  const hiddenCurLabJsx = useMemo(() => {
    if (!hiddenLabsRendered) return null;
    if (bullets.length === 0 || containerW === 0) return null;
    return (
      <div
        className="sc-ab-measure"
        aria-hidden="true"
        style={{ width: containerW }}
      >
        <ul className="sc-ab-list" ref={hiddenCurFullRef}>
          {bullets.map((b, i) => (
            <li key={`cf${i}`} className="sc-ab-item is-active">
              <BulletItemInner b={b} m={maxMode(b)} parentNodeId={parentNodeId} onRef={onReferenceClick} resolution={referenceResolution} bulletIndex={i} sourceMarks={sourceMarksByField} />
            </li>
          ))}
        </ul>
        <ul className="sc-ab-list" ref={hiddenCurM0Ref}>
          {bullets.map((b, i) => (
            <li key={`cz${i}`} className="sc-ab-item">
              <BulletItemInner b={b} m={0} parentNodeId={parentNodeId} onRef={onReferenceClick} resolution={referenceResolution} bulletIndex={i} sourceMarks={sourceMarksByField} />
            </li>
          ))}
        </ul>
        <ul className="sc-ab-list" ref={hiddenCurM1Ref}>
          {bullets.map((b, i) => (
            <li key={`co${i}`} className="sc-ab-item">
              <BulletItemInner b={b} m={Math.min(1, maxMode(b))} parentNodeId={parentNodeId} onRef={onReferenceClick} resolution={referenceResolution} bulletIndex={i} sourceMarks={sourceMarksByField} />
            </li>
          ))}
        </ul>
      </div>
    );
  }, [hiddenLabsRendered, bullets, containerW, parentNodeId, onReferenceClick, referenceResolution, sourceMarksByField]);

  const handleFreeTextClick = (e: ReactMouseEvent) => {
    // Don't collapse the active bullet when this click is the tail end of a
    // text-selection drag (selection still non-collapsed at click time).
    if (!window.getSelection()?.isCollapsed) return;
    const t = e.target as HTMLElement;
    if (t.closest('.ref-chip, .cite-marker, a, button')) return;
    // Click on the opening paragraph (or any free-text area) clears any
    // active bullet — gives the user a "background click" to deactivate
    // without having to hit the active bullet itself or press Esc.
    //
    // We deliberately do NOT stopPropagation: the click must also bubble up to
    // NodeView's wrapper onClick so that clicking the paragraph of an UNFOCUSED
    // node brings it into focus (collapse + focus together, one click). NodeView
    // guards `if (!selected) onSelect()`, so an already-focused node just
    // collapses — no double-focus, and NodeView stops the bubble there so the
    // canvas never deselects.
    if (activeIdx !== null) {
      setActiveIdx(null);
    }
  };

  // Clean copy: when (almost) the whole node body is selected, hand the
  // clipboard a model-reconstructed plain-text version (chip words inline, no
  // `•` glyphs, proper `- ` / `  - ` list) instead of the DOM's artifact-prone
  // serialization. A small partial selection falls through to the browser's
  // (now chip-inclusive, mark-free) default copy.
  const handleCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !parsed) return;
    const root = containerRef.current;
    if (!root || (!root.contains(sel.anchorNode) && !root.contains(sel.focusNode))) return;
    const full = bulletsToPlainText(parsed);
    if (!full) return;
    const selLen = sel.toString().replace(/\s+/g, '').length;
    const fullLen = full.replace(/\s+/g, '').length;
    if (fullLen > 0 && selLen >= 0.8 * fullLen) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', full);
    }
  };

  return (
    <div
      ref={containerRef}
      className="sc-ab-root"
      style={pulseStyle}
      onCopy={handleCopy}
      data-sc-adaptive="true"
      data-sc-version="v9-layout-measure"
      data-sc-collapsed={collapsed ? 'true' : undefined}
      data-sc-a={sizingDiag?.A ?? ''}
      data-sc-b={sizingDiag?.B ?? ''}
      data-sc-raw={sizingDiag?.rawSize ?? ''}
      data-sc-safety={sizingDiag?.safety ?? ''}
      data-sc-minsize={sizingDiag?.minSize ?? ''}
    >
      {(freeText || freetextTargetedByPartial) && (
        <div
          ref={freeTextRef}
          // The `.is-expand-target` modifier kicks in only while
          // this freetext is being expand-part'd; it gives the div
          // a ~2-line min-height so the cursor has visible empty
          // space to sit in once the paragraph has been chewed back
          // to zero characters. Outside an expand operation, the
          // freetext sizes naturally to its content.
          className={`sc-ab-freetext${freetextTargetedByPartial ? ' is-expand-target' : ''}`}
          // Alignment is user-controlled (Settings → Canvas); must match the
          // hidden measurement clone above so node sizing stays in sync.
          style={{ textAlign: freeTextAlign }}
          // Scrollbar anchor — stop 0 = freetext. The NodeScrollbar
          // queries `body.querySelector('[data-sc-anchor="ft"]')` to
          // compute the tick dot's y position.
          data-sc-anchor="ft"
          data-sc-source-field="ft"
          onClick={handleFreeTextClick}
        >
          {renderFreeText(
            freeText,
            parentNodeId,
            onReferenceClick,
            perLine,
            referenceResolution,
            sourceMarksByField.get('ft'),
            factReview,
          )}
          {/* One-line shimmer while the opening paragraph is being expanded and
              has been chewed back to empty (awaiting the first streamed token). */}
          {freetextTargetedByPartial && !freeText.trim() && (
            <div className="skeleton sc-ab-skel-line" aria-hidden="true" />
          )}
          {/* Per-section expand button INTENTIONALLY OMITTED in the
              node-final v2 design (`expandSectionInSidePanel`
              equivalent). The "Expand selected" button in the side
              panel handles freetext + active-bullet targeting via
              the activeIdx + bulletsCollapsed signals. Keeping the
              in-body button would duplicate the affordance. */}
        </div>
      )}
      {/* Horizontal divider between the opening paragraph and the
          bullets list. Same line treatment as .node-footer's top
          border so the two horizontal rules in the node read as a
          consistent visual rhythm. The body's overflow: hidden clips
          this away naturally when the chevron toggle collapses the
          body. */}
      {freeText && bullets.length > 0 && !collapsed && !nodeBulletsCollapsed && <div className="sc-ab-divider" />}
      {bullets.length > 0 && (!collapsed || parkCollapsedList) && (
        <ul
          className="sc-ab-list"
          ref={visibleListRef}
          aria-hidden={collapsed && parkCollapsedList ? 'true' : undefined}
          style={collapsed && parkCollapsedList ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
        >
          {bullets.map((b, i) => {
            const m = modes[i] ?? 0;
            const max = maxMode(b);
            const isActive = activeIdx === i;
            const isRewriting = bulletTargetsByPartial.has(i);
            return (
              <li
                key={i}
                className={`sc-ab-item${isActive ? ' is-active' : ''}${isRewriting ? ' is-rewriting' : ''}`}
                // Scrollbar anchor — stops 1..N map to bullet 0..N-1.
                // NodeScrollbar queries `[data-sc-anchor="b-<i>"]` to
                // compute each tick dot's y position.
                data-sc-anchor={`b-${i}`}
                onClick={handleBulletClick(i)}
                onKeyDown={handleBulletKey(i)}
                role="button"
                tabIndex={0}
                aria-expanded={m >= max}
                // Full visibility and explicit activation are separate states.
                data-tip={isActive ? '' : m >= max ? 'Click to select bullet' : 'Click to expand bullet'}
              >
                <BulletItemInner b={b} m={m} parentNodeId={parentNodeId} onRef={onReferenceClick} resolution={referenceResolution} bulletIndex={i} sourceMarks={sourceMarksByField} factReview={factReview} />
                {/* One-line shimmer while THIS bullet is being expanded and its
                    L2 detail has been chewed back to empty (awaiting the first
                    streamed token). Visible-list only — the skeleton is a
                    transient loading affordance and must not feed node-size
                    measurement (the hidden clone has no skeleton). */}
                {isRewriting && b.children.length === 0 && (
                  <div className="sc-ab-skel-line" aria-hidden="true" />
                )}
                {/* Per-bullet expand button OMITTED — same reason
                    as the freetext button above: the side panel's
                    "Expand selected" handles the bullet target via
                    the activeIdx signal. Keeping the in-body
                    button would duplicate the affordance and
                    crowd the bullet visually. */}
              </li>
            );
          })}
        </ul>
      )}
      {/* Tail skeleton — ghost bullet signalling more bullets are streaming
          in (pass 1 only). Display-only: never rendered inside the hidden
          labs, and its height is reserved explicitly in the sizing math —
          see STREAM_SKELETON_RESERVE. */}
      {showTailSkeleton && (
        <div className="sc-ab-skel-bullet" aria-hidden="true">
          <div className="sc-skel-bar sc-skel-title" />
          <div className="sc-skel-bar sc-skel-w90" />
          <div className="sc-skel-bar sc-skel-w72" />
        </div>
      )}
      <SourceSelectionOutline
        rootRef={containerRef}
        refreshKey={`${body}\u0000${modes.join(',')}\u0000${collapsed ? 1 : 0}\u0000${activeSourceOutlineKey}`}
      />
      {/* Hidden measurement lists. position:absolute inside .sc-ab-root
          (which has position: relative). visibility: hidden + pointer-
          events: none so they're invisible and don't catch input. They
          render the same bullets at fixed modes so that perBulletFull,
          perBulletM0, and perBulletM1 are always accurate for the current
          width without ever flashing the visible list.

          The M_max items carry .is-active because that's the state they're
          measured for — A_i = full_i_when_active + sum_{j!=i}(m0_j). The
          .is-active class bumps the title-text font-weight from 500 to
          600, which can wrap a borderline title to one extra line. Without
          this, A_i under-measures by that extra line and activating such a
          bullet overflows the body (the bottom items get cut). */}
      {hiddenLabJsx}
      {hiddenCurLabJsx}
    </div>
  );
}
