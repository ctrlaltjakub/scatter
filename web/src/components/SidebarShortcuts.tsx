'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useFollowUpFocusStore } from '@/store/useFollowUpFocusStore';
import { useScrollableHoverStore } from '@/store/useScrollableHoverStore';
import { useReadingStore } from '@/store/useReadingStore';
import { useImageSelectionStore } from '@/store/useImageSelectionStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { useCanvasSelectionStore } from '@/store/useCanvasSelectionStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { listSwitchableModels } from '@/store/providerSelectors';
import { currentContentType } from '@/lib/nodeContentType';
import { isStillImageMedia } from '@/lib/imageEditActions';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { GROUP_LABEL_ZOOM_THRESHOLD } from '@/lib/asciiAura/groupLabels';
import { KEY_ACTIONS, actionGlyph, bindingToGlyph, resolveBindings, type Availability } from '@/lib/keymap';

const LINGER_MS = 500;

/**
 * Hold a `true` value true immediately; hold a `false` value true
 * for `ms` after the flip, then let it go false. Rapid flips back
 * to true within the linger window cancel the pending hide.
 *
 * Used here so shortcuts stay visible briefly after they become
 * unavailable — the user doesn't lose sight of a shortcut just
 * because they happened to click outside / cancel the chip hover.
 */
function useLinger(value: boolean, ms: number): boolean {
  const [lingered, setLingered] = useState(value);
  useEffect(() => {
    if (value) {
      setLingered(true);
      return;
    }
    const t = window.setTimeout(() => setLingered(false), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return lingered;
}

/**
 * Compact keyboard-shortcut reference in the sidebar. Three rules:
 *
 *   1. ONLY actionable shortcuts shown — `canUndo`, `hasSelection`,
 *      etc. drive visibility.
 *
 *   2. NEWEST AT TOP — when a shortcut newly becomes visible, it
 *      slots in at the top of the list; older ones stay anchored
 *      in their existing positions. Timestamps stored in a ref-Map
 *      determine sort order.
 *
 *   3. LINGER before disappearing — when a shortcut's
 *      availability flips false, it stays visible briefly
 *      (via the `useLinger` hook). Eliminates "blink-and-
 *      it's-gone" flicker on transient state changes.
 *
 *   4. Ctrl/⌘+click row is special: it tracks chip hover via a
 *      JS mouseover listener (the CSS `:has()` approach can't
 *      participate in the JS-driven linger). It's rendered FIRST
 *      in the JSX so when visible it slots in at the top of the
 *      flex column, above the timestamp-sorted block.
 */
export function SidebarShortcuts() {
  const hasNodes = useGraphStore(s => !!s.project && Object.keys(s.project.nodes).length > 0);
  const multipleModels = useSettingsStore(s => listSwitchableModels(s).length > 1);
  const hasSelection = useGraphStore((s) => (s.project?.selection.length ?? 0) > 0);
  const imageSelected = useGraphStore((s) => {
    const ids = s.project?.selection;
    const node = ids?.length === 1 ? s.project?.nodes[ids[0]!] : undefined;
    return !!node && isStillImageMedia(node.versions[node.currentVersionIndex]?.media);
  });
  const imageDetailsVisible = useLiveViewportStore((s) => s.zoom >= GROUP_LABEL_ZOOM_THRESHOLD);
  // Exactly one TEXT node selected (media nodes have nothing to read) — gates
  // the reading-ruler hint.
  const textSelection = useGraphStore((s) => {
    const sel = s.project?.selection;
    if (!sel || sel.length !== 1) return false;
    const n = s.project?.nodes[sel[0]!];
    return !!n && currentContentType(n) !== 'media' && !!n.versions[n.currentVersionIndex]?.body.trim();
  });
  const canUndo = useStore(useGraphStore.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useGraphStore.temporal, (s) => s.futureStates.length > 0);

  // Chip-hover detection via delegated mouseover in the capture
  // phase. mouseover fires once per "entered new element," not on
  // every pixel of movement, so this is cheap. The dedup guard
  // (prev === isChip ? prev : isChip) prevents re-renders when
  // moving WITHIN the same chip.
  const [chipHoveredRaw, setChipHoveredRaw] = useState(false);
  const [nodeHovered, setNodeHovered] = useState(false);
  const [overScrollable, setOverScrollable] = useState(false);
  const [inputContext, setInputContext] = useState<'chat' | 'followup' | 'field' | null>(null);
  useEffect(() => {
    let disposed = false;
    const onOver = (e: MouseEvent) => {
      const t = e.target as Element | null;
      const isChip = !!t?.closest?.('.ref-chip.unexplored');
      setChipHoveredRaw((prev) => (prev === isChip ? prev : isChip));
      setNodeHovered(!!t?.closest?.('.node[data-node-id]') && !t?.closest?.('button, a, input, textarea, select, [role="button"], [contenteditable="true"], [data-image-selection-surface], .node-resize, .node-followup-bar'));
      setOverScrollable(!!t?.closest?.('.node.selected, .chat-scroll, .side-panel, .citations-panel'));
    };
    const onFocus = () => {
      if (disposed) return;
      const t = document.activeElement;
      const field = t?.matches('input, textarea, select, [contenteditable="true"]');
      setInputContext(!field ? null : t?.closest('.chat-composer') ? 'chat' : t?.closest('.node-followup-bar') ? 'followup' : 'field');
    };
    const onBlur = () => { setChipHoveredRaw(false); setNodeHovered(false); setOverScrollable(false); };
    const onFocusOut = () => queueMicrotask(onFocus);
    onFocus();
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('mouseover', onOver, true);
    return () => {
      disposed = true;
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onFocusOut, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // "Force zoom" hint — shown while the pointer is over a focused node whose
  // body steps through bullets (the wheel there would otherwise scroll content,
  // so Ctrl/⌘+scroll is the escape hatch that always zooms).
  const scrollHoverRaw = useScrollableHoverStore((s) => s.nodeId !== null);

  // Briefly linger transient availability flags.
  const showUndo = useLinger(canUndo, LINGER_MS);
  const showRedo = useLinger(canRedo, LINGER_MS);
  const showDeselect = useLinger(hasSelection, LINGER_MS);
  const showText = useLinger(textSelection, LINGER_MS);
  const showChip = useLinger(chipHoveredRaw, LINGER_MS);
  const showScroll = useLinger(scrollHoverRaw || overScrollable, LINGER_MS);

  const tsMap = useRef<Map<string, number>>(new Map());
  // Custom key overrides so the displayed combos track rebindings.
  const overrides = useSettingsStore((s) => s.keybindings);

  // Typing-only shortcuts for the node follow-up box — shown only while that
  // textarea is focused, and reflecting the Enter-behaviour setting.
  const followUpFocused = useFollowUpFocusStore((s) => s.focused);
  const enterSends = useSettingsStore((s) => s.followUpEnterSends);
  const readingReference = useReadingStore((s) => s.activeReference);
  const readingActive = useReadingStore(s => !!s.nodeId);
  const imageParts = useImageSelectionStore(s => !!s.selection?.regions.length);
  const textParts = useNodeTextSelectionStore(s => !!s.selection);
  const selecting = useCanvasSelectionStore(s => !!s.marquee);
  const focusedChatId = useGraphStore(s => {
    const ids = s.project?.selection;
    const node = ids?.length === 1 ? s.project?.nodes[ids[0]!] : undefined;
    return node?.chat ? node.id : undefined;
  });
  const generatingChat = useGraphStore(s => !!focusedChatId && !!s.project?.nodes[focusedChatId]?.generating);
  const focusedEmptyText = useGraphStore(s => {
    const ids = s.project?.selection;
    const node = ids?.length === 1 ? s.project?.nodes[ids[0]!] : undefined;
    const version = node?.versions[node.currentVersionIndex];
    return !!version?.emptyText && !version.body.trim();
  });
  const compactingChat = useChatRuntimeStore(s => !!focusedChatId && !!s.views[focusedChatId]?.compacting);
  const chatBusy = generatingChat || compactingChat;
  const escapeHint = chatBusy ? 'stop generating' : inputContext ? 'leave text field' : selecting ? 'cancel selection'
    : imageParts ? 'clear image selection' : readingActive ? 'exit reading ruler' : textParts ? 'clear text selection' : undefined;
  const typingRows = followUpFocused
    ? [
        ...(!chatBusy ? [{ id: 'fu-ask', keys: enterSends ? '↵' : 'Ctrl/⌘+↵', hint: inputContext === 'chat' ? 'send message' : focusedEmptyText ? 'generate node' : 'ask follow-up' }] : []),
        { id: 'fu-newline', keys: enterSends ? '⇧↵ / Ctrl/⌘+↵' : '↵ / ⇧↵', hint: 'new line' },
      ]
    : [];
  const readingRows = readingReference && !inputContext
    ? readingReference.kind === 'selection'
      ? [{ id: 'reading-show-selection', keys: '↵ / Ctrl/⌘+↵', hint: 'Show selection' }]
      : readingReference.childId
      ? [{ id: 'reading-show-term', keys: '↵ / Ctrl/⌘+↵', hint: 'Show term' }]
      : [
          { id: 'reading-explore-term', keys: '↵', hint: 'Explore term' },
          { id: 'reading-explore-collapsed', keys: 'Ctrl/⌘+↵', hint: 'Explore collapsed' },
        ]
    : [];

  // Catalog derived from the keymap registry (single source of truth with
  // the live keydown handler) using LINGERED visibility, so timestamps track
  // when each row actually appears on-screen (not the raw availability edge —
  // that would lose entries the moment they flip false, before the linger had
  // a chance to keep them visible).
  const availMap: Record<Availability, boolean> = {
    always: true,
    canUndo: showUndo,
    canRedo: showRedo,
    hasSelection: showDeselect,
    textSelection: showText,
    chipHover: showChip,
    scrollHover: showScroll,
    nodeHover: nodeHovered,
    hasNodes,
    multipleModels,
  };
  // Pan and zoom remain separate in the keymap/settings, but share one compact
  // sidebar row. Both are fixed camera gestures with the same availability.
  const cameraKeys = `${actionGlyph('pan', overrides)} ${actionGlyph('zoom', overrides).replaceAll(' ', '')}`;
  const catalog = KEY_ACTIONS.filter((a) => a.id !== 'zoom').map((a) => ({
    id: a.id,
    keys: a.id === 'pan' ? cameraKeys
      : a.rebindable ? resolveBindings(a.id, overrides).map(bindingToGlyph).join(' / ') : actionGlyph(a.id, overrides),
    hint: a.id === 'pan' ? 'control camera' : a.hint,
    visible: (a.availability ? availMap[a.availability] : true)
      && (!inputContext || !!a.worksInEditable || a.id === 'forceScroll')
      && (a.id !== 'deselect' || !escapeHint),
    isChip: a.availability === 'chipHover',
  }));

  const now = Date.now();
  for (const s of catalog) {
    if (s.isChip) continue;
    if (s.visible && !tsMap.current.has(s.id)) tsMap.current.set(s.id, now);
    if (!s.visible && tsMap.current.has(s.id)) tsMap.current.delete(s.id);
  }

  const tsSorted = catalog
    .filter((s) => !s.isChip && s.visible)
    .sort((a, b) => (tsMap.current.get(b.id) ?? 0) - (tsMap.current.get(a.id) ?? 0));
  const chipRows = catalog.filter((s) => s.isChip && s.visible);

  return (
    <div className="sidebar-shortcuts">
      {escapeHint && <Row keys="Esc" hint={escapeHint} />}
      {imageSelected && imageDetailsVisible && !inputContext && <>
        <Row keys="Drag" hint="Select image part" />
        <Row keys="Ctrl/⌘+Drag" hint="Add image parts" />
      </>}
      {readingRows.map((s) => (
        <Row key={s.id} keys={s.keys} hint={s.hint} />
      ))}
      {typingRows.map((s) => (
        <Row key={s.id} keys={s.keys} hint={s.hint} />
      ))}
      {chipRows.map((s) => (
        <Row key={s.id} keys={s.keys} hint={s.hint} />
      ))}
      {tsSorted.map((s) => (
        <Row key={s.id} keys={s.keys} hint={s.hint} />
      ))}
    </div>
  );
}

interface RowProps {
  keys: string;
  hint: string;
}

function Row({ keys, hint }: RowProps) {
  return (
    <div className="sidebar-shortcut">
      <span className="shortcut-keys">{renderKeyGroups(keys)}</span>
      <span className="shortcut-hint">{hint}</span>
    </div>
  );
}

/** Wrap between modifiers, never into the description column. Keep the final
 *  modifier + drag together so long gestures read as Ctrl/⌘+ then Shift+drag.
 *  Spaces still separate alternatives, arrow keys, and the camera controls. */
function renderKeyGroups(keys: string): React.ReactNode[] {
  const parts = keys.split(/(\s+)/).flatMap((part) => part.split(/(?<=\+)(?!drag$)/i));
  return parts.flatMap<React.ReactNode>((part, i) => /^\s+$/.test(part) ? [part] : [
    <span key={`part-${i}`} className="shortcut-key-part">{renderKeyChars(part)}</span>,
    <wbr key={`break-${i}`} />,
  ]);
}

/** Render a key string with `⌘` characters wrapped in a span so CSS
 *  can style them at a larger font-size. Everything else passes
 *  through as plain text. */
function renderKeyChars(keys: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let buf = '';
  let k = 0;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === '⌘') {
      if (buf) { out.push(buf); buf = ''; }
      out.push(<span key={k++} className="cmd-glyph">⌘</span>);
    } else {
      buf += keys[i];
    }
  }
  if (buf) out.push(buf);
  return out;
}
