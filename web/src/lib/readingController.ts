/**
 * Reading-ruler orchestration — executes the pure state machine
 * (readingNav) against the live DOM (readingDom) and the stores.
 *
 * Called from the single global keydown handler in app/page.tsx whenever a
 * bare arrow key is pressed with exactly one node selected. Section
 * crossings reuse the wheel stepper's path (useActiveIdxStore.set) and then
 * WAIT for the bullet cascade to settle — the new section's height animates
 * for ~0.25 s and may run extra measure-correct passes — by polling the
 * section anchor's rect until it holds still (3 stable frames, 700 ms cap).
 * Arrows arriving mid-cross are swallowed so key repeat can't stack crosses.
 */
import { useGraphStore } from '@/store/useGraphStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useReadingStore } from '@/store/useReadingStore';
import { activateReference } from './referenceAction';
import { navigateExistingRelation } from './relationNavigation';
import { activateChatAnswer } from './chat/actions';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { mutedAccentHex } from './groupColor';
import { transition, type ArrowKey, type NavCtx } from './readingNav';
import {
  buildLineModel,
  clearReadAccent,
  clearReadingPaint,
  paintReading,
  readingRects,
  readingTarget,
  referenceForCluster,
  sectionElement,
  setReadAccent,
  type SectionModel,
} from './readingDom';

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Runtime id for a source viewer opened without a graph-node citation. */
export const SOURCE_VIEWER_READING_ID = '__scatter-source-viewer__';

export function isReadingArrow(key: string): key is ArrowKey {
  return ARROW_KEYS.has(key);
}

export function readingActive(): boolean {
  return useReadingStore.getState().nodeId !== null;
}

/* ── Pending section cross (at most one) ── */
let crossRaf = 0;
let crossToken = 0;

function cancelCross(): void {
  crossToken++;
  if (crossRaf) cancelAnimationFrame(crossRaf);
  crossRaf = 0;
}

function crossPending(): boolean {
  return crossRaf !== 0;
}

export function exitReading(): void {
  cancelCross();
  if (useReadingStore.getState().nodeId === null) return;
  useReadingStore.getState().reset();
  clearReadingPaint();
  clearReadAccent();
}

/* ── Helpers ── */

export function readingSurfaceFor(nodeId: string): HTMLElement | null {
  const overlay = document.querySelector<HTMLElement>(
    `[data-sc-reading-node-id="${CSS.escape(nodeId)}"]`,
  );
  if (overlay) return overlay;
  return document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
}

/** The node's accent (group color → project color), same resolution as the
 *  card tints in NodeView. */
function nodeAccent(nodeId: string): string | null {
  const p = useGraphStore.getState().project;
  if (!p) return null;
  const gid = p.nodes[nodeId]?.groupId;
  if (!gid) return p.color ?? null;
  return p.groups[gid]?.color ?? p.color ?? null;
}

/** Highest readable stop. Visible bullet rows are counted from the DOM (only
 *  rendered content carries anchors); a collapsed body clips the bullets, so
 *  reading stays in the opening paragraph there. */
function lastStop(cardEl: Element, nodeId: string): number {
  if (cardEl.hasAttribute('data-sc-reading-table')) return 0;
  if (cardEl.classList.contains('chat-node')) return Math.max(0, cardEl.querySelectorAll('.chat-assistant .chat-markdown').length - 1);
  if (cardEl.hasAttribute('data-sc-reading-standalone')) return 0;
  if (useGraphStore.getState().project?.nodes[nodeId]?.bulletsCollapsed) return 0;
  return cardEl.querySelectorAll('.sc-ab-item[data-sc-anchor^="b-"]').length;
}

function modelFor(cardEl: Element, stop: number): SectionModel | null {
  const el = sectionElement(cardEl, stop);
  if (!el) return null;
  const explicitScale = Number.parseFloat(
    cardEl.getAttribute('data-sc-reading-scale') ?? '',
  );
  const scale = Number.isFinite(explicitScale) && explicitScale > 0
    ? explicitScale
    : useLiveViewportStore.getState().zoom;
  return buildLineModel(el, scale);
}

function chatReadingViewport(cardEl: Element): HTMLElement | null {
  return cardEl.matches('.chat-table-content') ? cardEl as HTMLElement
    : cardEl.querySelector<HTMLElement>('[data-chat-scroll]');
}

/** Compressed answer bands are navigation context, not full-size reading lines. */
function readingViewportBox(viewport: HTMLElement) {
  const box = viewport.getBoundingClientRect();
  const scale = box.height / (viewport.offsetHeight || box.height || 1);
  return { left: box.left, right: box.right,
    top: box.top + (Number(viewport.dataset.readingInsetTop) || 0) * scale,
    bottom: box.bottom - (Number(viewport.dataset.readingInsetBottom) || 0) * scale };
}

function isVisibleReadingLine(model: SectionModel, lineIdx: number, viewport: HTMLElement, fully = false): boolean {
  const line = model.lines[lineIdx];
  if (!line) return false;
  const box = readingViewportBox(viewport);
  const top = Math.max(0, box.top), bottom = Math.min(window.innerHeight, box.bottom);
  return readingRects(model, line.start, line.end).some((rect) => rect.right > box.left && rect.left < box.right
    && (fully ? rect.top >= top - 0.5 && rect.bottom <= bottom + 0.5 : rect.bottom > top && rect.top < bottom));
}

/** Find the first fully visible line, across answer boundaries and table cells. */
function visibleChatReadingStart(cardEl: Element, nodeId: string): { stop: number; lineIdx: number; model: SectionModel } | null {
  const viewport = chatReadingViewport(cardEl);
  if (!viewport) return null;
  const box = readingViewportBox(viewport);
  for (let stop = 0; stop <= lastStop(cardEl, nodeId); stop++) {
    const element = sectionElement(cardEl, stop);
    const rect = element?.getBoundingClientRect();
    if (!rect || rect.bottom <= box.top || rect.top >= box.bottom) continue;
    const model = modelFor(cardEl, stop);
    if (!model) continue;
    const lineIdx = model.lines.findIndex((_line, index) => isVisibleReadingLine(model, index, viewport, true));
    if (lineIdx >= 0) return { stop, lineIdx, model };
  }
  return null;
}

function commitReadingPosition(
  model: SectionModel,
  stop: number,
  lineIdx: number,
  clusterIdx: number | null,
): void {
  const reference = referenceForCluster(model, clusterIdx);
  useReadingStore.getState().setPos(
    stop,
    lineIdx,
    clusterIdx,
    reference,
  );
  paintReading(model, lineIdx, clusterIdx);
  const cluster = readingTarget(model, lineIdx, clusterIdx);
  const span = cluster && model.spans.find((item) => item.end > cluster.start);
  const owner = span?.node.parentElement?.closest<HTMLElement>('[data-chat-answer]');
  const nodeId = useReadingStore.getState().nodeId;
  if (owner && nodeId && span && cluster) {
    const turnId = owner.dataset.chatAnswer;
    const versionCreatedAt = Number(owner.dataset.chatAnswerCreatedAt);
    if (turnId && Number.isFinite(versionCreatedAt)) activateChatAnswer(nodeId, { turnId, versionCreatedAt });
    const scroll = owner.closest<HTMLElement>('[data-chat-scroll], .chat-table-content');
    if (scroll) {
      useChatRuntimeStore.getState().view(nodeId, { atBottom: false });
      const rects = readingRects(model, cluster.start, cluster.end);
      if (!rects.length) return;
      const rect = { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)),
        left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) };
      const box = readingViewportBox(scroll);
      const scale = scroll.classList.contains('chat-table-content') ? 1 : useLiveViewportStore.getState().zoom || 1;
      if (rect.bottom > box.bottom - 14) scroll.scrollTop += (rect.bottom - box.bottom + 14) / scale;
      else if (rect.top < box.top + 14) scroll.scrollTop -= (box.top + 14 - rect.top) / scale;
      const horizontal = span.node.parentElement?.closest<HTMLElement>('.chat-table-scroll') ?? scroll;
      const horizontalBox = horizontal.getBoundingClientRect();
      if (rect.right > horizontalBox.right - 14) horizontal.scrollLeft += (rect.right - horizontalBox.right + 14) / scale;
      else if (rect.left < horizontalBox.left + 14) horizontal.scrollLeft -= (horizontalBox.left + 14 - rect.left) / scale;
    }
  }
}

/** Sync the cascade to a stop — the exact path the wheel stepper takes. */
function setStop(nodeId: string, stop: number): void {
  const node = useGraphStore.getState().project?.nodes[nodeId];
  if (node?.chat || node?.versions[node.currentVersionIndex]?.contentType === 'answer') return;
  if (readingSurfaceFor(nodeId)?.hasAttribute('data-sc-reading-standalone')) return;
  useActiveIdxStore.getState().set(nodeId, stop <= 0 ? null : stop - 1);
}

/** Poll until the target section's rect (and the body height) hold still for
 *  3 consecutive frames — the cascade + height transition have finished —
 *  with a 700 ms hard cap. Cancelled by exit or another cross. */
function waitForSettle(cardEl: Element, stop: number, cb: () => void): void {
  const token = ++crossToken;
  const body = cardEl.querySelector('.node-body');
  const started = performance.now();
  let stable = 0;
  let prev: { top: number; h: number; bh: number } | null = null;
  const tick = () => {
    if (token !== crossToken) return; // cancelled
    const anchor = sectionElement(cardEl, stop);
    const r = anchor?.getBoundingClientRect();
    const timedOut = performance.now() - started > 700;
    if (r) {
      const cur = { top: r.top, h: r.height, bh: body?.getBoundingClientRect().height ?? 0 };
      stable =
        prev &&
        Math.abs(cur.top - prev.top) < 0.5 &&
        Math.abs(cur.h - prev.h) < 0.5 &&
        Math.abs(cur.bh - prev.bh) < 0.5
          ? stable + 1
          : 0;
      prev = cur;
      if (stable >= 3 || timedOut) {
        crossRaf = 0;
        cb();
        return;
      }
    } else if (timedOut) {
      crossRaf = 0;
      cb();
      return;
    }
    crossRaf = requestAnimationFrame(tick);
  };
  crossRaf = requestAnimationFrame(tick);
}

/** Activate `targetStop`, wait for the cascade, then land the highlight on
 *  its first (dir 1) or last (dir -1) line — scanning onward past empty
 *  sections. Used both for crossings and for a start whose entry section
 *  turned out empty. */
function landIn(nodeId: string, cardEl: Element, targetStop: number, dir: 1 | -1, wordMode: boolean): void {
  if (targetStop < 0 || targetStop > lastStop(cardEl, nodeId)) return;
  clearReadingPaint();
  useReadingStore.getState().setPos(targetStop, 0, null, null);
  setStop(nodeId, targetStop);
  waitForSettle(cardEl, targetStop, () => {
    if (useReadingStore.getState().nodeId !== nodeId) return;
    const model = modelFor(cardEl, targetStop);
    if (!model) {
      landIn(nodeId, cardEl, targetStop + dir, dir, wordMode);
      return;
    }
    const lineIdx = dir === 1 ? 0 : model.lines.length - 1;
    const line = model.lines[lineIdx];
    if (!line) return; // unreachable: a model always has ≥1 line
    const clusterIdx = wordMode
      ? (dir === 1 ? line.firstClusterIdx : line.lastClusterIdx)
      : null;
    commitReadingPosition(model, targetStop, lineIdx, clusterIdx);
  });
}

function startReading(nodeId: string, cardEl: Element, wordMode: boolean): void {
  const last = lastStop(cardEl, nodeId);
  const activeIdx = useActiveIdxStore.getState().byNodeId[nodeId] ?? null;
  const chat = useGraphStore.getState().project?.nodes[nodeId]?.chat;
  const activeTurn = useChatRuntimeStore.getState().views[nodeId]?.active?.turnId;
  const visible = visibleChatReadingStart(cardEl, nodeId);
  const entryStop = visible?.stop ?? (chat && !cardEl.hasAttribute('data-sc-reading-table')
    ? Math.max(0, Math.min(last, chat.turns.findIndex((turn) => turn.id === activeTurn)))
    : Math.min(activeIdx === null ? 0 : activeIdx + 1, last));

  // Bring the node into view if it's (partly) off-screen — reuses the
  // spawn/search pan: computeTarget does a MINIMUM pan and is a no-op when
  // the node already fits, so it never jolts an already-visible card. The
  // painted highlight rides along (it's anchored to the text, and the camera
  // is a CSS transform — no re-measure needed).
  if (!cardEl.hasAttribute('data-sc-reading-node-id')) {
    useGraphStore.getState().requestPanTo(nodeId, undefined, 'reading');
  }

  // The ruler wears the node's own color. A standalone source viewer has no
  // owning node, so it uses the active project's color instead.
  const accent = cardEl.hasAttribute('data-sc-reading-standalone')
    ? useGraphStore.getState().project?.color ?? null
    : nodeAccent(nodeId);
  setReadAccent(mutedAccentHex(accent, 0, 0, 0));
  const entryLine = visible?.lineIdx ?? 0;
  useReadingStore.getState().begin(nodeId, entryStop, entryLine, null);

  const model = visible?.model ?? modelFor(cardEl, entryStop);
  const firstLine = model?.lines[entryLine];
  if (model && firstLine) {
    const clusterIdx = wordMode ? firstLine.firstClusterIdx : null;
    commitReadingPosition(model, entryStop, entryLine, clusterIdx);
    return;
  }
  // Entry section has no readable text (e.g. a body with bullets but an
  // empty opening) — land in the first non-empty section below instead.
  if (entryStop < last) landIn(nodeId, cardEl, entryStop + 1, 1, wordMode);
  else if (useGraphStore.getState().project?.nodes[nodeId]?.generating) {
    // A fresh stream can temporarily have no rendered text. Keep the reading
    // session alive; ReadingHighlighter reconciles as soon as text arrives.
    clearReadingPaint();
  } else {
    exitReading(); // nothing readable at all
  }
}

/** Rebuild and repaint the current reading position after React has rendered a
 * streamed text mutation. Empty streaming content clears only the paint; the
 * reading state remains armed so it can resume on the next mutation. */
export function reconcileReading(expectedNodeId?: string): void {
  const reading = useReadingStore.getState();
  const nodeId = reading.nodeId;
  if (!nodeId || (expectedNodeId && expectedNodeId !== nodeId)) return;
  const cardEl = readingSurfaceFor(nodeId);
  const node = useGraphStore.getState().project?.nodes[nodeId];
  if (!cardEl || (!node && !cardEl.hasAttribute('data-sc-reading-standalone'))) {
    exitReading();
    return;
  }

  const stop = Math.min(Math.max(reading.stop, 0), lastStop(cardEl, nodeId));
  const model = modelFor(cardEl, stop);
  if (!model || model.lines.length === 0) {
    useReadingStore.getState().setPos(stop, 0, null, null);
    clearReadingPaint();
    return;
  }
  const lineIdx = Math.min(Math.max(reading.lineIdx, 0), model.lines.length - 1);
  const clusterIdx = reading.clusterIdx === null || model.clusters.length === 0
    ? null
    : Math.min(Math.max(reading.clusterIdx, 0), model.clusters.length - 1);
  if (stop !== reading.stop) setStop(nodeId, stop);
  commitReadingPosition(model, stop, lineIdx, clusterIdx);
}

/** Activate the term currently selected by word-by-word reading. Returns
 * false for line mode or an ordinary word so the caller leaves Enter alone. */
export function activateReadingReference(withModifier: boolean): boolean {
  const reference = useReadingStore.getState().activeReference;
  if (!reference) return false;
  if (reference.kind === 'selection') {
    const arrow = useGraphStore.getState().project?.arrows[reference.arrowId];
    if (!arrow) return false;
    navigateExistingRelation(arrow);
    return true;
  }
  const owner = reference.element.closest<HTMLElement>('[data-chat-answer]');
  const sourceAnswer = owner?.dataset.chatAnswer ? { turnId: owner.dataset.chatAnswer,
    versionCreatedAt: Number(owner.dataset.chatAnswerCreatedAt) } : undefined;
  activateReference(reference.parentNodeId, reference.term, { withModifier, sourceAnswer });
  return true;
}

/* ── The single entry point for arrow keys (called from page.tsx) ── */

export function handleReadingArrow(key: string, nodeId: string): void {
  if (!isReadingArrow(key)) return;
  if (crossPending()) return; // mid-cross: swallow (key repeat can't stack)

  const reading = useReadingStore.getState();
  const cardEl = readingSurfaceFor(nodeId);
  if (!cardEl) return;

  if (reading.nodeId !== nodeId) {
    if (reading.nodeId !== null) exitReading(); // was reading another node
    const node = useGraphStore.getState().project?.nodes[nodeId];
    if (!node && !cardEl.hasAttribute('data-sc-reading-standalone')) return;
    const action = transition(null, key, {
      lineCount: 0,
      clusterCount: 0,
      firstClusterOnLine: [],
      lastClusterOnLine: [],
      clusterHomeLine: [],
    }, { atFirstStop: true, atLastStop: true });
    if (action.kind === 'start') startReading(nodeId, cardEl, action.wordMode);
    return;
  }

  const model = modelFor(cardEl, reading.stop);
  if (!model) {
    if (useGraphStore.getState().project?.nodes[nodeId]?.generating) {
      useReadingStore.getState().setPos(reading.stop, 0, null, null);
      clearReadingPaint();
    }
    else exitReading(); // section vanished under us (rare — watcher usually got it)
    return;
  }
  // Clamp a possibly-stale position against the fresh model.
  const lineIdx = Math.min(Math.max(reading.lineIdx, 0), model.lines.length - 1);
  const clusterIdx = reading.clusterIdx === null ? null : Math.min(reading.clusterIdx, model.clusters.length - 1);
  const viewport = chatReadingViewport(cardEl);
  if (viewport && !isVisibleReadingLine(model, lineIdx, viewport)) {
    // Manual scrolling may leave the old ruler above/below the viewport.
    // The next arrow begins where the user is looking, not at stale context.
    startReading(nodeId, cardEl, key === 'ArrowLeft' || key === 'ArrowRight');
    return;
  }
  const ctx: NavCtx = {
    atFirstStop: reading.stop <= 0,
    atLastStop: reading.stop >= lastStop(cardEl, nodeId),
  };
  const action = transition({ lineIdx, clusterIdx }, key, model.shape, ctx);
  switch (action.kind) {
    case 'move':
      commitReadingPosition(model, reading.stop, action.lineIdx, action.clusterIdx);
      break;
    case 'crossSection':
      landIn(nodeId, cardEl, reading.stop + action.dir, action.dir, action.wordMode);
      break;
    case 'exit':
      exitReading();
      break;
    default:
      break; // noop / start (start can't occur while active)
  }
}
