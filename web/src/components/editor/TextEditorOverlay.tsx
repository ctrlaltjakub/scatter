'use client';
import { useReadingTypography } from '@/hooks/useReadingTypography';
import { languageInfo, languageDirection } from '@/lib/languages';
import { VersionCounter } from '@/components/VersionCounter';
import { GoogleSearchSuggestions } from '@/components/node/GoogleSearchSuggestions';
/**
 * Full-window "Edit text" editor — a normal node card, made big, on a blurred
 * canvas. While open, the app temporarily hides both the Sidebar and the
 * canvas top-right controls; editor-local Undo/Redo remain in the left panel.
 * The card + detached panels live above the blurred canvas. The
 * version/export panel floats to the card's left and the Modify bar floats
 * below — exactly how a node floats its panels.
 *
 * The first edit creates a recovery version; later edits update that version.
 * Closing and switching versions flush pending edits without discarding them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { EditorState } from '@tiptap/pm/state';
import { ChevronLeft, ChevronRight, Copy, FileDown, FilePlus, FileText, IndentDecrease, IndentIncrease, Save, Sparkles, SquareArrowRight, Trash, WrapText } from 'lucide-react';
import { useEditorStore } from '@/store/useEditorStore';
import { useGraphStore } from '@/store/useGraphStore';
import { removeNodeVersion } from '@/lib/nodeVersions';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useDisplayBody, useHasAnyActive, useIsWholeActive } from '@/store/useRewriteStore';
import { generateTextVersionFromHeader, modifyNode, saveManualEdit } from '@/lib/generate';
import { colorToCss } from '@/lib/groupColor';
import { bodyToDoc, docToBody, docToModel } from '@/lib/editorSerialize';
import { currentContentType, isExplainContentType } from '@/lib/nodeContentType';
import type { HeaderParts, NodeType } from '@/store/types';
import { modelToMarkdown } from '@/lib/editorMarkdown';
import { modelToDocxBlob } from '@/lib/editorDocx';
import { withExportBibliography } from '@/lib/exportSources';
import { downloadBlob, sanitizeFilename } from '@/lib/download';
import { buildExtensions } from './editorExtensions';
import { buildAnswerExtensions } from './answerExtensions';
import { answerBodyToDoc, answerDocToBody } from '@/lib/answerEditorSerialize';
import { chatMarkdownToDocx } from '@/lib/chat/export';
import { stripChips } from '@/lib/bulletParse';
import { demoteOutline, promoteOutline } from './outlineCommands';
import { EditorBottomBar } from './EditorBottomBar';
import { EditorSelectionToolbar } from './EditorSelectionToolbar';
import { EditorTermToolbar } from './EditorTermToolbar';
import { outlineLevelToolsDisabled } from './editorActionState';
import { StructuredHeaderEditor } from '@/components/node/StructuredHeaderEditor';
import {
  flattenHeaderParts,
  normalizeHeaderParts,
  regenerateFromHeaderLabel,
  resolveVersionHeaderParts,
  semanticHeaderText,
} from '@/lib/nodeHeaderText';
import { useGenerationPulseSync } from '@/hooks/useGenerationPulseSync';
import { EditorHistoryButtons } from './EditorHistoryButtons';
import { MarkdownEditorToolbar } from './MarkdownEditorToolbar';
import { editMarkdownSource } from './markdownCommands';
import { selectionFromMarkdown, selectionToMarkdown, type MarkdownSelection } from './markdownSelection';

function bodySignature(editor: Editor): string {
  return editor.schema.nodes.table ? answerDocToBody(editor.getJSON()) : docToBody(editor.getJSON());
}

/** A textarea does not scroll its programmatically restored selection into
 * view. Measure the caret on a temporary, identically wrapped copy only when
 * switching modes; this never changes the source or runs while typing. */
function focusMarkdownSource(field: HTMLTextAreaElement, selection: MarkdownSelection) {
  field.setSelectionRange(selection.from, selection.to, selection.direction);
  field.focus({ preventScroll: true });
  if (field.scrollHeight <= field.clientHeight) return;
  const style = getComputedStyle(field);
  const mirror = document.createElement('div');
  for (const property of ['font', 'line-height', 'letter-spacing', 'tab-size', 'padding', 'word-break', 'overflow-wrap']) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden',
    width: `${field.clientWidth}px`, boxSizing: 'border-box', whiteSpace: 'pre-wrap',
  });
  mirror.textContent = field.value + '\u200b';
  document.body.append(mirror);
  try {
    const caret = document.createRange();
    caret.setStart(mirror.firstChild!, selection.direction === 'backward' ? selection.from : selection.to);
    caret.collapse(true);
    const bounds = caret.getBoundingClientRect();
    const top = bounds.top - mirror.getBoundingClientRect().top;
    const bottom = top + (bounds.height || parseFloat(style.lineHeight));
    const padding = parseFloat(style.paddingTop) || 0;
    if (top < field.scrollTop + padding) field.scrollTop = Math.max(0, top - padding);
    else if (bottom > field.scrollTop + field.clientHeight - padding) field.scrollTop = bottom - field.clientHeight + padding;
  } finally {
    mirror.remove();
  }
}

function useTextEditorHistory(editor: Editor | null): number {
  const subscribe = useCallback((onChange: () => void) => {
    if (!editor) return () => {};
    editor.on('transaction', onChange);
    return () => { editor.off('transaction', onChange); };
  }, [editor]);
  const getSnapshot = useCallback(() => (
    editor ? (editor.can().undo() ? 1 : 0) | (editor.can().redo() ? 2 : 0) : 0
  ), [editor]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

/** The group-color accent cascade (same vars NodeView/NodeSidePanel set). */
function groupVars(gc: string): CSSProperties {
  return {
    '--tint-1': `color-mix(in oklab, ${gc} 5%, transparent)`,
    '--tint-2': `color-mix(in oklab, ${gc} 10%, transparent)`,
    '--tint-3': `color-mix(in oklab, ${gc} 22%, transparent)`,
    '--tint-4': `color-mix(in oklab, ${gc} 30%, transparent)`,
    '--control-accent': gc,
    '--node-tag-bg': `color-mix(in oklab, ${gc} 25%, transparent)`,
    '--sel-bg': `color-mix(in oklab, ${gc} 40%, transparent)`,
  } as CSSProperties;
}

function EditorWindow({ nodeId }: { nodeId: string }) {
  const project = useGraphStore((s) => s.project);
  const close = useEditorStore((s) => s.close);
  const node = project?.nodes[nodeId];
  const verIdx = node?.currentVersionIndex ?? 0;
  // Drive the editor's formatting off the CURRENT version's content type (not
  // node.type), so editing an older, re-typed version uses the right structure.
  const editorContentType = node ? currentContentType(node) : 'encyclopedic';
  const isAnswer = editorContentType === 'answer';
  const editorNodeType: NodeType =
    isExplainContentType(editorContentType) ? 'explain'
    : editorContentType === 'media' ? 'media'
    : 'term-click';

  // Per-node override of the global "information chunking" setting.
  const sentencePerLine = useSettingsStore((s) => s.sentencePerLine);
  const chunkIntro = isAnswer ? !!node?.versions[verIdx]?.chat?.informationChunking : node?.chunkIntro ?? sentencePerLine;

  const extensions = useMemo(() => isAnswer ? buildAnswerExtensions() : buildExtensions(editorNodeType), [editorNodeType, isAnswer]);
  // Each saved version has its own editing session. Loading a version or
  // mirroring an AI stream must not create an "undo to empty document" step.
  const editor = useEditor({ extensions, content: '', immediatelyRender: false }, [nodeId, isAnswer, editorNodeType]);
  // TipTap owns unsaved body history. Subscribe to the two capability bits so
  // ordinary typing does not force an additional React render when the button
  // states stay unchanged.
  const editorHistory = useTextEditorHistory(editor);
  useEffect(() => {
    if (!editor?.storage.answerEditing) return;
    editor.storage.answerEditing.chunked = chunkIntro;
    editor.view.dispatch(editor.state.tr.setMeta('answerChunking', chunkIntro));
  }, [editor, chunkIntro]);

  const baselineRef = useRef('');
  const draftVersionRef = useRef<number | undefined>();
  const editProjectRef = useRef(project?.id);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pendingSaveRef = useRef<{ parts?: HeaderParts; body?: string }>();
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const sourceSelectionRef = useRef<MarkdownSelection>({ from: 0, to: 0 });
  const modeFocusRef = useRef<boolean | null>(null);
  const sourceHistory = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const currentVersion = node?.versions[verIdx];
  const typography = useReadingTypography(currentVersion?.language, `${currentVersion?.header ?? ''}\n${currentVersion?.body ?? ''}`);
  const resolvedHeaderParts = useMemo(
    () => node && currentVersion && project
      ? resolveVersionHeaderParts(node, currentVersion, project.arrows)
      : { subject: currentVersion?.header ?? '' },
    [currentVersion, node, project],
  );
  const [headerDraft, setHeaderDraft] = useState<HeaderParts>(resolvedHeaderParts);

  // Live generation state — the editor mirrors the SAME generation the canvas
  // shows (whether it started here or on the canvas). `isStreaming` = the node
  // is mid-generation; `displayBody` is the live working body (working-body
  // stream during a rewrite, or the committed body otherwise).
  const generating = useGraphStore((s) => !!s.project?.nodes[nodeId]?.generating);
  const generationError = useGraphStore((s) => s.project?.nodes[nodeId]?.generationError ?? null);
  const wholeActive = useIsWholeActive(nodeId);
  const anyActive = useHasAnyActive(nodeId);
  const committedBody = node?.versions[verIdx]?.body ?? '';
  const displayBody = useDisplayBody(nodeId, verIdx, committedBody);
  const isStreaming = generating || wholeActive;
  const pulseStyle = useGenerationPulseSync(isStreaming);
  // Same gate the canvas node uses (NodeBody): show skeleton in the gap after
  // the old text is chewed away and before the first new token.
  const showSkeleton = (wholeActive || (generating && !anyActive)) && displayBody.trim() === '';

  // Transfer focus after the destination view is visible, before the next
  // paint/keystroke. Mode/selection changes are navigation, not content edits.
  useLayoutEffect(() => {
    if (modeFocusRef.current !== sourceMode || isStreaming) return;
    modeFocusRef.current = null;
    if (sourceMode) {
      if (sourceRef.current) focusMarkdownSource(sourceRef.current, sourceSelectionRef.current);
    } else {
      editor?.view.focus();
      editor?.commands.scrollIntoView();
    }
  }, [sourceMode, editor, isStreaming]);

  // Calmer, slower scrolling inside the article.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // line-mode → px
      el.scrollTop += px * 0.5;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Seed the editor from the committed version — on mount, on version switch,
  // and when a generation FINISHES (so the final, chip-marked result loads and
  // the editor unlocks). Skipped while streaming: the mirror effect owns the
  // view then. Chunking only changes presentation, never the working document.
  useEffect(() => {
    if (!editor || !node || isStreaming) return;
    const cur = node.versions[verIdx];
    if (!cur) return;
    if (draftVersionRef.current === cur.createdAt) return;
    draftVersionRef.current = undefined;
    const nextParts = project ? resolveVersionHeaderParts(node, cur, project.arrows) : { subject: cur.header };
    setHeaderDraft(nextParts);
    setSourceText(cur.body);
    sourceHistory.current = { past: [], future: [] };
    const document = isAnswer ? answerBodyToDoc(cur.body) : bodyToDoc(cur.body, editorNodeType, flattenHeaderParts(nextParts), chunkIntro);
    editor.view.updateState(EditorState.create({ schema: editor.schema, doc: editor.schema.nodeFromJSON(document), plugins: editor.state.plugins }));
    baselineRef.current = `${JSON.stringify(normalizeHeaderParts(nextParts))} ${isAnswer && sourceMode ? cur.body : bodySignature(editor)}`;
    if (!isAnswer) setSourceMode(false);
    editor.setEditable(true, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, verIdx, currentVersion?.createdAt, isStreaming]);

  // While the node is generating, mirror its live working body into the editor
  // (locked). This renders the same delete → stream
  // the canvas shows — they're the one generation. The skeleton (in the JSX
  // below) covers the empty gap before the first token.
  useEffect(() => {
    if (!editor || !node || !isStreaming) return;
    editor.setEditable(false, false);
    if (!showSkeleton) {
      const cur = node.versions[verIdx];
      const parts = cur && project ? resolveVersionHeaderParts(node, cur, project.arrows) : resolvedHeaderParts;
      setHeaderDraft((previous) => (
        JSON.stringify(normalizeHeaderParts(previous)) === JSON.stringify(normalizeHeaderParts(parts))
          ? previous
          : parts
      ));
      setSourceText(displayBody);
      editor.chain().setContent(isAnswer ? answerBodyToDoc(displayBody) : bodyToDoc(displayBody, editorNodeType, flattenHeaderParts(parts), chunkIntro), false)
        .command(({ tr }) => { tr.setMeta('addToHistory', false); return true; }).run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, isStreaming, displayBody, showSkeleton, node, project, verIdx, editorNodeType, chunkIntro, resolvedHeaderParts]);

  const saveDraft = useCallback((parts = headerDraft, body = isAnswer && sourceMode ? sourceText : editor ? bodySignature(editor) : '') => {
    clearTimeout(saveTimerRef.current); pendingSaveRef.current = undefined;
    if (!editor || isStreaming || useGraphStore.getState().project?.id !== editProjectRef.current) return;
    const signature = `${JSON.stringify(normalizeHeaderParts(parts))} ${body}`;
    if (signature === baselineRef.current) return;
    draftVersionRef.current = saveManualEdit(nodeId, parts, body, draftVersionRef.current);
    baselineRef.current = signature;
  }, [editor, isStreaming, nodeId, headerDraft, isAnswer, sourceMode, sourceText]);
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;
  const scheduleSave = (parts?: HeaderParts, body?: string) => {
    // Create the recovery version immediately, then coalesce typing so a long
    // document does not re-render the entire canvas on every keystroke.
    if (draftVersionRef.current == null) { saveDraftRef.current(parts, body); return; }
    pendingSaveRef.current = { parts, body };
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const pending = pendingSaveRef.current;
      if (pending) saveDraftRef.current(pending.parts, pending.body);
    }, 250);
  };
  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;
  useEffect(() => () => {
    const pending = pendingSaveRef.current;
    if (pending) saveDraftRef.current(pending.parts, pending.body);
    clearTimeout(saveTimerRef.current);
  }, []);
  const updateSource = (body: string) => {
    if (body !== sourceText) {
      const past = [...sourceHistory.current.past, sourceText].slice(-50);
      // Embedded image sources can be large. Bound source undo memory as well
      // as its entry count; saved node versions remain available separately.
      while (past.length > 1 && past.reduce((total, text) => total + text.length, 0) > 4_000_000) past.shift();
      sourceHistory.current = { past, future: [] };
    }
    setSourceText(body); scheduleSave(headerDraft, body);
  };
  const sourceUndo = (redo = false) => {
    const history = sourceHistory.current;
    const stack = redo ? history.future : history.past;
    const text = stack.pop();
    if (text == null) return;
    (redo ? history.past : history.future).push(sourceText);
    setSourceText(text); saveDraft(headerDraft, text);
  };
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => scheduleSaveRef.current();
    editor.on('update', onUpdate);
    return () => { editor.off('update', onUpdate); };
  }, [editor]);

  const doClose = useCallback(() => {
    // Don't commit a partial stream — a running generation commits its own
    // version on finish; closing just leaves it to complete on the canvas.
    saveDraft();
    close();
  }, [close, saveDraft]);

  // Run Modify through the SHARED generation engine so the canvas mirrors it
  // (and the editor mirrors it via the effect above). Checkpoint any unsaved
  // typing first — as its own version — so the AI revises THIS text and nothing
  // is lost (the chosen "save per Modify" behavior).
  const submitModify = useCallback((instruction: string) => {
    if (!editor || !node || isStreaming) return;
    saveDraft();
    draftVersionRef.current = undefined;
    void modifyNode(nodeId, instruction);
  }, [editor, node, nodeId, isStreaming, saveDraft]);

  // Esc closes (auto-saving when changed). Capture phase beats the global Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.querySelector('.markdown-format-menu, .markdown-insert-form')) return;
        e.preventDefault();
        e.stopPropagation();
        doClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [doClose]);

  // Node deleted while open → bail.
  useEffect(() => {
    if (!node) close();
  }, [node, close]);

  if (!node) return null;
  const total = node.versions.length;
  const regenerateLabel = regenerateFromHeaderLabel(headerDraft);

  const switchVersion = (delta: -1 | 1) => {
    const next = Math.max(0, Math.min(total - 1, verIdx + delta));
    if (next === verIdx) return;
    saveDraft();
    draftVersionRef.current = undefined;
    useGraphStore.getState().updateNode(nodeId, { currentVersionIndex: next });
  };

  const saveAsNew = () => {
    if (!editor) return;
    saveDraft();
    draftVersionRef.current = undefined;
    saveManualEdit(nodeId, headerDraft, sourceMode ? sourceText : bodySignature(editor));
  };

  const newBlank = () => {
    saveDraft();
    draftVersionRef.current = undefined;
    saveManualEdit(nodeId, headerDraft, '');
  };

  const generateFromHeader = () => {
    if (!editor || isStreaming || !semanticHeaderText(headerDraft)) return;
    const captured = normalizeHeaderParts(headerDraft);
    saveDraft(captured);
    draftVersionRef.current = undefined;
    void generateTextVersionFromHeader(nodeId, captured);
  };

  const deleteVersion = () => {
    if (total <= 1) return;
    clearTimeout(saveTimerRef.current);
    pendingSaveRef.current = undefined;
    draftVersionRef.current = undefined;
    const current = useGraphStore.getState().project?.nodes[nodeId];
    const patch = current && currentVersion && removeNodeVersion(current, currentVersion.createdAt);
    if (patch) useGraphStore.getState().updateNode(nodeId, patch);
  };

  const demote = () =>
    editor?.chain().focus().command(({ state, dispatch }) => demoteOutline(state, dispatch)).run();
  const promote = () =>
    editor?.chain().focus().command(({ state, dispatch }) => promoteOutline(state, dispatch)).run();

  // Presentation only: keep authored breaks, the caret, and editor undo history.
  const toggleChunk = () => {
    if (!editor || !node) return;
    if (isAnswer) {
      saveDraft();
      const current = useGraphStore.getState().project?.nodes[nodeId];
      if (!current) return;
      const versions = [...current.versions];
      const version = versions[current.currentVersionIndex]!;
      if (version.chat) versions[current.currentVersionIndex] = { ...version, chat: { ...version.chat, informationChunking: !version.chat.informationChunking } };
      useGraphStore.getState().updateNode(nodeId, { versions });
      return;
    }
    const next = !(node.chunkIntro ?? sentencePerLine);
    useGraphStore.getState().updateNode(nodeId, { chunkIntro: next });
    editor.view.focus();
  };

  const exportMd = () => {
    if (!editor) return;
    if (isAnswer) {
      const body = answerDocToBody(sourceMode ? answerBodyToDoc(sourceText) : editor.getJSON(), { stripTerms: true });
      downloadBlob(new Blob([withExportBibliography(`# ${flattenHeaderParts(headerDraft)}\n\n${body}`, currentVersion)], { type: 'text/markdown' }), `${sanitizeFilename(flattenHeaderParts(headerDraft))}.md`);
      return;
    }
    const m = { ...docToModel(editor.getJSON()), title: flattenHeaderParts(headerDraft) };
    downloadBlob(new Blob([withExportBibliography(modelToMarkdown(m), currentVersion)], { type: 'text/markdown' }), `${sanitizeFilename(m.title)}.md`);
  };
  const exportDocx = async () => {
    if (!editor) return;
    if (isAnswer) {
      const body = answerDocToBody(sourceMode ? answerBodyToDoc(sourceText) : editor.getJSON(), { stripTerms: true });
      downloadBlob(await chatMarkdownToDocx(withExportBibliography(`# ${flattenHeaderParts(headerDraft)}\n\n${body}`, currentVersion), currentVersion?.language), `${sanitizeFilename(flattenHeaderParts(headerDraft))}.docx`);
      return;
    }
    const m = { ...docToModel(editor.getJSON()), title: flattenHeaderParts(headerDraft) };
    downloadBlob(await modelToDocxBlob(m, currentVersion?.language, currentVersion), `${sanitizeFilename(m.title)}.docx`);
  };
  const copyAll = () => {
    if (!editor) return;
    const model = { ...docToModel(editor.getJSON()), title: flattenHeaderParts(headerDraft) };
    void navigator.clipboard?.writeText(isAnswer ? `# ${flattenHeaderParts(headerDraft)}\n\n${stripChips(sourceMode ? sourceText : bodySignature(editor))}` : modelToMarkdown(model));
    setCopiedAll(true);
    window.setTimeout(() => setCopiedAll(false), 1200);
  };

  const groupColor =
    (node.groupId ? project?.groups[node.groupId]?.color : undefined) ?? project?.color;
  const style = groupColor ? groupVars(colorToCss(groupColor)) : undefined;

  return (
    <>
      <div className="text-editor-backdrop" />
      <div
        className="text-editor-stage"
        style={style}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) doClose();
        }}
      >
        <div
          className="text-editor-group"
          onMouseDown={(e) => {
            // Clicking the blurred area beside the card (the group's own empty
            // space) dismisses the editor, auto-saving like Esc / the close X.
            if (e.target === e.currentTarget) doClose();
          }}
        >
          <aside className="text-editor-panel">
            <div className="versions-row">
              <div className="versions-row-cluster">
                <button type="button" disabled={verIdx === 0 || isStreaming} onClick={() => switchVersion(-1)} data-tip="Previous version" aria-label="Previous version">
                  <ChevronLeft size={13} />
                </button>
                <VersionCounter current={verIdx + 1} total={total} showTooltip={false} />
                <button type="button" disabled={verIdx >= total - 1 || isStreaming} onClick={() => switchVersion(1)} data-tip="Next version" aria-label="Next version">
                  <ChevronRight size={13} />
                </button>
              </div>
              <div className="versions-row-actions">
                <EditorHistoryButtons
                  canUndo={(sourceMode ? sourceHistory.current.past.length > 0 : (editorHistory & 1) !== 0) && !isStreaming}
                  canRedo={(sourceMode ? sourceHistory.current.future.length > 0 : (editorHistory & 2) !== 0) && !isStreaming}
                  onUndo={() => { if (sourceMode) sourceUndo(); else editor?.chain().focus().undo().run(); }}
                  onRedo={() => { if (sourceMode) sourceUndo(true); else editor?.chain().focus().redo().run(); }}
                  noun="text edit"
                />
                <button type="button" disabled={!editor || isStreaming} onClick={saveAsNew} data-tip="Save current edits as a new version" aria-label="Save as new version">
                  <Save size={13} />
                </button>
                <button type="button" disabled={total <= 1 || isStreaming} onClick={deleteVersion} data-tip="Delete this version" aria-label="Delete version">
                  <Trash size={13} />
                </button>
              </div>
            </div>

            {!isAnswer && <button
              type="button"
              className="side-action side-action--tall"
              disabled={!editor || isStreaming || !semanticHeaderText(headerDraft)}
              onClick={generateFromHeader}
              data-tip={`${regenerateLabel} as a new text version`}
            >
              <span className="side-action-icon"><Sparkles size={15} /></span>
              {regenerateLabel}
            </button>}

            <button type="button" className="side-action" disabled={isStreaming} onClick={newBlank} data-tip="Add a blank version to write from scratch">
              <span className="side-action-icon"><FilePlus size={15} /></span> New blank version
            </button>

            <div className="te-divider" />

            <button
              type="button"
              className="side-action side-action--tall"
              disabled={!editor || isStreaming}
              onMouseDown={event => event.preventDefault()}
              onClick={toggleChunk}
              aria-pressed={chunkIntro}
              data-tip="Display authored prose lines separately with indented wrapping. Line breaks are preserved; punctuation does not add new ones."
            >
              <span className="side-action-icon"><WrapText size={15} /></span>
              Information chunking: {chunkIntro ? 'On' : 'Off'}
            </button>

            {!isAnswer && !isExplainContentType(editorContentType) && <><div className="te-divider" />

            <button
              type="button"
              className="side-action"
              disabled={outlineLevelToolsDisabled(editorContentType, !!editor, isStreaming)}
              onClick={demote}
              data-tip={isExplainContentType(editorContentType) ? 'Explain nodes use prose, so bullet levels do not apply' : 'Demote bullet to level 2 (Tab)'}
            >
              <span className="side-action-icon"><IndentIncrease size={15} /></span> Demote bullet
            </button>
            <button
              type="button"
              className="side-action"
              disabled={outlineLevelToolsDisabled(editorContentType, !!editor, isStreaming)}
              onClick={promote}
              data-tip={isExplainContentType(editorContentType) ? 'Explain nodes use prose, so bullet levels do not apply' : 'Promote bullet to level 1 (Shift+Tab)'}
            >
              <span className="side-action-icon"><IndentDecrease size={15} /></span> Promote bullet
            </button>

            <div className="te-divider" /></>}

            <button type="button" className="side-action" disabled={!editor} onClick={copyAll} data-tip="Copy the whole article to the clipboard">
              <span className="side-action-icon"><Copy size={15} /></span> {copiedAll ? 'Copied!' : 'Copy whole text'}
            </button>
            <button type="button" className="side-action" disabled={!editor} onClick={exportMd} data-tip="Download as Markdown">
              <span className="side-action-icon"><FileText size={15} /></span> Export to .md
            </button>
            <button type="button" className="side-action" disabled={!editor} onClick={() => void exportDocx()} data-tip="Download as Word">
              <span className="side-action-icon"><FileDown size={15} /></span> Export to .docx
            </button>
          </aside>

          <div className="text-editor-cardwrap" lang={languageInfo(currentVersion?.language).locale}
            data-language-direction={languageDirection(currentVersion?.language)} style={{ ...typography, fontFamily: undefined, fontSizeAdjust: undefined }}>
            <div
              className={'text-editor-card' + (isStreaming ? ' is-modifying' : '')}
              style={pulseStyle}
              role="dialog"
              aria-modal="true"
            >
              <div className="text-editor-fixed-header">
                  <button type="button" className="text-editor-exit" onClick={doClose} data-tip="Exit (Esc) — saves your changes">
                    <SquareArrowRight size={15} /> Exit
                  </button>
                  <StructuredHeaderEditor
                    value={headerDraft}
                    onChange={parts => { setHeaderDraft(parts); scheduleSave(parts); }}
                    disabled={isStreaming}
                    pulsing={isStreaming}
                    className="text-editor-structured-header"
                  />
                    {isAnswer && <MarkdownEditorToolbar editor={editor} disabled={isStreaming}
                      sourceMode={sourceMode} onToggleSource={nextMode => {
                        if (!editor || isStreaming) return;
                        if (nextMode === sourceMode) {
                          if (sourceMode) sourceRef.current?.focus();
                          else editor.view.focus();
                          return;
                        }
                        saveDraft();
                        if (sourceMode) {
                          const field = sourceRef.current;
                          const range = field ? { from: field.selectionStart, to: field.selectionEnd, direction: field.selectionDirection } : sourceSelectionRef.current;
                          const parsed = editor.schema.nodeFromJSON(answerBodyToDoc(sourceText));
                          const doc = parsed.eq(editor.state.doc) ? editor.state.doc : parsed;
                          const selection = selectionFromMarkdown(doc, sourceText, range);
                          if (doc === editor.state.doc) editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta('addToHistory', false));
                          else editor.view.updateState(EditorState.create({ schema: editor.schema, doc, selection, plugins: editor.state.plugins }));
                        } else {
                          const body = bodySignature(editor);
                          sourceSelectionRef.current = selectionToMarkdown(editor.state, body);
                          setSourceText(body); sourceHistory.current = { past: [], future: [] };
                        }
                        // Parsing may normalize Markdown whitespace/delimiters.
                        // Merely changing the view is not a content edit.
                        baselineRef.current = `${JSON.stringify(normalizeHeaderParts(headerDraft))} ${bodySignature(editor)}`;
                        modeFocusRef.current = nextMode;
                        setSourceMode(nextMode);
                      }} source={sourceMode ? {
                        get: () => ({ text: sourceText, ...sourceSelectionRef.current }),
                        set: next => {
                          updateSource(next.text); sourceSelectionRef.current = { from: next.from, to: next.to };
                          requestAnimationFrame(() => { sourceRef.current?.focus(); sourceRef.current?.setSelectionRange(next.from, next.to); });
                        },
                      } : undefined} />}
              </div>
              <div className="text-editor-scroll" ref={scrollRef}>
                <div className={'text-editor-doc' + (isAnswer ? ' is-markdown' : '')}>
                  {showSkeleton && <div className="text-editor-article text-editor-skeleton" aria-hidden="true">
                    <div className="sc-node-skeleton">
                      <div className="sc-skel-bar sc-skel-w95" /><div className="sc-skel-bar sc-skel-w88" />
                      <div className="sc-skel-bar sc-skel-w72" /><div className="sc-skel-bar sc-skel-w90" /><div className="sc-skel-bar sc-skel-w60" />
                    </div>
                  </div>}
                  <div className={isAnswer ? 'text-editor-article editor-markdown-frame' : undefined}
                    role={isAnswer ? 'group' : undefined} aria-label={isAnswer ? 'Markdown text' : undefined}
                    style={showSkeleton ? { display: 'none' } : undefined}>
                    {isAnswer && sourceMode && <textarea ref={sourceRef} className="markdown-source-editor" aria-label="Markdown source" spellCheck={false} value={sourceText} disabled={isStreaming}
                      onSelect={event => { sourceSelectionRef.current = { from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd, direction: event.currentTarget.selectionDirection }; }}
                      onChange={event => updateSource(event.target.value)}
                      onKeyDown={event => {
                        event.stopPropagation();
                        const modifier = event.ctrlKey || event.metaKey;
                        if (modifier && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); sourceUndo(event.shiftKey || event.key.toLowerCase() === 'y'); return; }
                        if (modifier && ['b', 'i', 'e'].includes(event.key.toLowerCase())) {
                          event.preventDefault(); const field = event.currentTarget;
                          const next = editMarkdownSource({ text: sourceText, from: field.selectionStart, to: field.selectionEnd }, event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : 'code');
                          updateSource(next.text); requestAnimationFrame(() => field.setSelectionRange(next.from, next.to)); return;
                        }
                        if (event.key !== 'Tab') return;
                        event.preventDefault();
                        const field = event.currentTarget, start = field.selectionStart, end = field.selectionEnd;
                        const lineStart = field.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
                        const removed = event.shiftKey ? field.value.slice(lineStart).match(/^(?: {1,2}|\t)/)?.[0].length ?? 0 : 0;
                        const value = event.shiftKey ? field.value.slice(0, lineStart) + field.value.slice(lineStart + removed) : field.value.slice(0, start) + '  ' + field.value.slice(end);
                        updateSource(value);
                        const caret = event.shiftKey ? Math.max(lineStart, start - removed) : start + 2;
                        requestAnimationFrame(() => field.setSelectionRange(caret, caret));
                      }} />}
                    {/* Keep TipTap mounted: recreating its content view can
                        detach the focused DOM again after a mode switch. */}
                    <EditorContent editor={editor} style={isAnswer && sourceMode ? { display: 'none' } : undefined}
                      className={'text-editor-article has-structured-header' + (isAnswer ? ' answer-editor-article' : chunkIntro ? ' is-chunked' : '') + (isExplainContentType(editorContentType) ? ' is-explain' : '')} />
                  </div>
                  {!showSkeleton && !!node?.versions[verIdx]?.googleSearchSuggestions?.length &&
                    <GoogleSearchSuggestions snippets={node.versions[verIdx]?.googleSearchSuggestions} />}
                </div>
              </div>
            </div>
            <EditorBottomBar busy={isStreaming} error={generationError} onSubmitModify={submitModify} />
          </div>
        </div>

        {!sourceMode && <EditorSelectionToolbar editor={editor} />}
        {!sourceMode && <EditorTermToolbar editor={editor} />}
      </div>
    </>
  );
}

export default function TextEditorOverlay() {
  const open = useEditorStore((s) => s.open);
  const nodeId = useEditorStore((s) => s.nodeId);
  if (!open || !nodeId) return null;
  return <EditorWindow key={nodeId} nodeId={nodeId} />;
}
