'use client';
/**
 * Full-window image crop/annotate editor — the media-node sibling of the
 * "Edit text" editor, copying its anatomy 1:1: blurred backdrop (z-26) +
 * stage (z-28) → [ left panel · card + bottom bar ] group. Saving FLATTENS
 * the annotations/crop/adjustments into a new bitmap stored as a NEW node
 * version — the untouched original stays one version back, and closing with
 * changes auto-saves exactly like the text editor.
 *
 * The session stays MOUNTED across version switches (and saves, which move
 * the version pointer): the previous image keeps showing while the next one
 * loads, with a spinner overlay only if loading takes >0.5s — no flicker.
 * Editor state (history/tool/selection) resets per version via an effect.
 *
 * The editor keeps its own gesture-aware undo history (imageEditElements);
 * Ctrl+Z here never touches the app's zundo stack — the capture-phase key
 * handler stops handled keys before page.tsx's bubble-phase handler sees
 * them, and the app toolbar's Undo/Redo route here through the store's
 * undoHandle while the editor is open; visible duplicates live in its left
 * panel because the app sidebar is temporarily hidden.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { SquareArrowRight } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { removeNodeVersion } from '@/lib/nodeVersions';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { useImageSelectionStore } from '@/store/useImageSelectionStore';
import { EMPTY_IMAGE_REGIONS } from '@/lib/imageRegions';
import { askImageFollowUp } from '@/lib/imageFollowUp';
import { loadAsset } from '@/opfs/assetsIO';
import { colorToCss, resolveColorHex } from '@/lib/groupColor';
import {
  applyOp, canRedo, canUndo, commitGesture, emptyDoc, initHistory, isDirty, redo, undo,
  type AnnotEl, type EditorHistory, type EditorOp, type TextEl,
} from '@/lib/imageEditElements';
import { rotateCropForQuarterTurn, turnedDims } from '@/lib/imageEditGeometry';
import { APP_FONT_ID, ensureFontLoaded, fontFamilyFor, nearestTextSizePx } from '@/lib/imageEditFonts';
import { isEditableImageMedia, isGifMedia, saveEditedImage, saveMediaHeaderVersion } from '@/lib/imageEditActions';
import {
  generateImageVersionFromHeader,
  modifyImageInMediaNode,
} from '@/lib/imageGeneration';
import { useImageGenerationAvailable } from '@/hooks/useImageGenerationAvailable';
import { useImageEditingCapability } from '@/hooks/useImageEditingCapability';
import {
  normalizeHeaderParts,
  regenerateFromHeaderLabel,
  resolveVersionHeaderParts,
  semanticHeaderText,
} from '@/lib/nodeHeaderText';
import type { HeaderParts, ImageRegion } from '@/store/types';
import { StructuredHeaderEditor } from '@/components/node/StructuredHeaderEditor';
import { GenerationMediaSkeleton } from '@/components/GenerationMediaSkeleton';
import { ImageEditorCanvas, type EditorTool, type ImageEditorCanvasHandle } from './ImageEditorCanvas';
import { ImageEditorPanel } from './ImageEditorPanel';
import { ImageEditorBottomBar } from './ImageEditorBottomBar';
import {
  IMAGE_EDITOR_ZOOM_STEP,
  ImageEditorViewportController,
} from '@/lib/imageEditorViewport';

/** The group-color accent cascade (same vars NodeView/TextEditorOverlay set). */
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

/** What the current version's media allows. */
type Phase = 'ready' | 'error' | 'gif' | 'nomedia' | 'generating';

function EditorSession({ nodeId, verIdx }: { nodeId: string; verIdx: number }) {
  const close = useImageEditorStore((s) => s.close);
  const setUndoHandle = useImageEditorStore((s) => s.setUndoHandle);
  const project = useGraphStore((s) => s.project);
  const node = project?.nodes[nodeId];
  const version = node?.versions[verIdx];
  const media = version?.media;
  const generating = !!node?.generating && !!version?.imageGeneration && !media;
  const generationError = node?.generationError;
  const imageGenerationAvailable = useImageGenerationAvailable();
  const imageEditingCapability = useImageEditingCapability();
  const viewportController = useMemo(() => new ImageEditorViewportController(), []);
  useEffect(() => () => viewportController.destroy(), [viewportController]);
  const resolvedHeader = useMemo(
    () => node && version && project
      ? resolveVersionHeaderParts(node, version, project.arrows)
      : { subject: version?.header ?? '' },
    [node, project, version],
  );
  const [headerDraft, setHeaderDraft] = useState<HeaderParts>(resolvedHeader);
  const headerBaselineRef = useRef(JSON.stringify(normalizeHeaderParts(resolvedHeader)));

  // ── Editor document + history (editor-internal undo) ────────────────────
  const baseline = useMemo(() => emptyDoc(), []);
  const [history, setHistory] = useState<EditorHistory>(() => initHistory(emptyDoc()));
  const historyRef = useRef(history);
  historyRef.current = history;

  const dispatch = useCallback((op: EditorOp, transient?: boolean) => {
    setHistory((h) => applyOp(h, op, { transient }));
  }, []);
  const endGesture = useCallback(() => setHistory((h) => commitGesture(h)), []);
  const doUndo = useCallback(() => setHistory((h) => undo(h)), []);
  const doRedo = useCallback(() => setHistory((h) => redo(h)), []);

  // ── Tool state ───────────────────────────────────────────────────────────
  const [tool, setTool] = useState<EditorTool>('select');
  const [fontId, setFontId] = useState(APP_FONT_ID);
  const [fontTick, setFontTick] = useState(0);
  const [strokeWidth, setStrokeWidth] = useState(6);
  const [fontSize, setFontSize] = useState(32);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const editingRef = useRef(editingTextId);
  editingRef.current = editingTextId;

  // Node accent (group color, else project color) → recommended swatch + tints.
  const accent = useGraphStore((s) => {
    const n = s.project?.nodes[nodeId];
    return (n?.groupId ? s.project?.groups[n.groupId]?.color : undefined) ?? s.project?.color ?? null;
  });
  const accentHex = useMemo(() => (accent ? resolveColorHex(accent) : null), [accent]);
  const [color, setColor] = useState(() => accentHex ?? '#111111');

  // The app toolbar's Undo/Redo drive this session while it's open.
  useEffect(() => {
    setUndoHandle({ undo: doUndo, redo: doRedo, canUndo: canUndo(history), canRedo: canRedo(history) });
  }, [history, doUndo, doRedo, setUndoHandle]);
  useEffect(() => () => setUndoHandle(null), [setUndoHandle]);

  // ── Version switches: fresh document, keep the session (and old image) ───
  useEffect(() => {
    setHistory(initHistory(emptyDoc()));
    setSelectedIds([]);
    setEditingTextId(null);
    setTool((t) => (t === 'crop' ? 'select' : t));
    viewportController.fit();
    setHeaderDraft(resolvedHeader);
    headerBaselineRef.current = JSON.stringify(normalizeHeaderParts(resolvedHeader));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verIdx, viewportController]);

  // ── Load the source image (keep the previous one while loading) ─────────
  const [phase, setPhase] = useState<Phase>('ready');
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSpinner, setShowSpinner] = useState(false);
  const projectId = project?.id;
  const mediaKey = media ? `${media.source}:${media.assetId ?? media.url ?? ''}` : 'none';
  const imageRegions = useImageSelectionStore((s) => s.selection?.nodeId === nodeId
    && s.selection.projectId === projectId && s.selection.versionCreatedAt === version?.createdAt
    ? s.selection.regions : EMPTY_IMAGE_REGIONS);
  const setImageRegions = useCallback((regions: ImageRegion[]) => {
    if (projectId && version) useImageSelectionStore.getState().set({
      projectId, nodeId, versionCreatedAt: version.createdAt, regions,
    });
  }, [projectId, nodeId, version?.createdAt]);
  // Crop/rotation changes the displayed coordinate system. Do not silently
  // apply an old selection to different pixels after a geometry edit/undo.
  const cropKey = JSON.stringify(history.present.crop);
  const lastCropKey = useRef(cropKey);
  useEffect(() => {
    if (cropKey !== lastCropKey.current) useImageSelectionStore.getState().clear();
    lastCropKey.current = cropKey;
  }, [cropKey]);

  useEffect(() => {
    if (generating) {
      setPhase('generating');
      setLoading(false);
      setShowSpinner(false);
      return;
    }
    if (!projectId || !media || !isEditableImageMedia(media)) {
      setPhase('nomedia');
      setLoading(false);
      return;
    }
    if (isGifMedia(media)) {
      setPhase('gif');
      setLoading(false);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    setLoading(true);
    const spinnerTimer = window.setTimeout(() => setShowSpinner(true), 500);
    (async () => {
      try {
        let blob: Blob | null = null;
        if (media.source === 'asset' && media.assetId) {
          blob = await loadAsset(projectId, media.assetId);
        } else if (media.source === 'link' && media.url) {
          // Fetch-to-blob keeps the bitmap same-origin, so the export canvas
          // stays untainted. CORS-hostile hosts land in the error card below.
          const res = await fetch(media.url, { mode: 'cors' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          blob = await res.blob();
        }
        if (!blob) throw new Error('no bytes');
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        // Wait for LOAD, not decode(): Chrome parks decode jobs for hidden
        // tabs, so awaiting decode() can hang forever if the window loses
        // focus mid-open. Konva decodes on first draw anyway.
        await new Promise<void>((resolve, reject) => {
          if (img.complete && img.naturalWidth) { resolve(); return; }
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('image failed to load'));
        });
        void img.decode?.().catch(() => { /* best-effort pre-decode */ });
        if (!cancelled) {
          setImage(img);
          setPhase('ready');
          // Sensible defaults scale with the picture, not the screen.
          setStrokeWidth(Math.max(4, Math.round(img.naturalWidth / 300)));
          setFontSize(nearestTextSizePx(img.naturalWidth / 24));
        }
      } catch {
        if (!cancelled) setPhase('error');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setShowSpinner(false);
        }
        window.clearTimeout(spinnerTimer);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(spinnerTimer);
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verIdx, mediaKey, projectId, generating, media]);

  // ── Bake + save (the flatten) ────────────────────────────────────────────
  const canvasRef = useRef<ImageEditorCanvasHandle>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const ready = phase === 'ready' && !!image;

  const bakeAndSave = useCallback(async (parts: HeaderParts = headerDraft): Promise<boolean> => {
    if (savingRef.current) return false;
    const canvas = canvasRef.current;
    if (!canvas) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      const texts = historyRef.current.present.elements
        .filter((el): el is TextEl => el.tool === 'text');
      await Promise.all(texts.map((t) => ensureFontLoaded(t.fontFamily, t.text)));
      const { blob, width, height } = await canvas.exportBlob();
      const active = useGraphStore.getState().project;
      const activeNode = active?.nodes[nodeId];
      if (active?.id !== projectId || activeNode?.versions[activeNode.currentVersionIndex]?.createdAt !== version?.createdAt) {
        throw new Error('The source image changed while exporting.');
      }
      await saveEditedImage(nodeId, blob, { width, height }, parts);
      return true;
    } catch (err) {
      console.error('Image editor save failed', err);
      window.alert('Could not save the edited image — the browser refused to export it. Your edits are still open; you can undo them (Ctrl+Z) and exit.');
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [nodeId, headerDraft, projectId, version?.createdAt]);

  const dirty = ready && isDirty(history, baseline);
  const headerDirty = JSON.stringify(normalizeHeaderParts(headerDraft)) !== headerBaselineRef.current;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const headerDirtyRef = useRef(headerDirty);
  headerDirtyRef.current = headerDirty;
  const headerDraftRef = useRef(headerDraft);
  headerDraftRef.current = headerDraft;

  const doClose = useCallback(async () => {
    if (savingRef.current) return;
    if (dirtyRef.current) {
      const ok = await bakeAndSave(headerDraftRef.current);
      if (!ok) return; // stay open — the edits are still recoverable
    } else if (headerDirtyRef.current) {
      saveMediaHeaderVersion(nodeId, headerDraftRef.current);
    }
    close();
  }, [bakeAndSave, close]);

  // "Save as new version": the version pointer moves → the per-version reset
  // effect gives a clean history on the freshly-baked image, no remount.
  const saveAsNew = useCallback(() => {
    if (dirtyRef.current) void bakeAndSave(headerDraftRef.current);
    else if (headerDirtyRef.current) saveMediaHeaderVersion(nodeId, headerDraftRef.current);
  }, [bakeAndSave, nodeId]);

  const generateFromHeader = useCallback(async () => {
    if (savingRef.current || generating || !imageGenerationAvailable) return;
    const captured = normalizeHeaderParts(headerDraftRef.current);
    if (!semanticHeaderText(captured)) return;
    if (dirtyRef.current) {
      const saved = await bakeAndSave(captured);
      if (!saved) return;
    }
    await generateImageVersionFromHeader(nodeId, captured);
  }, [bakeAndSave, generating, imageGenerationAvailable, nodeId]);

  const modifyWithAi = useCallback(async (instruction: string) => {
    if (savingRef.current || generating || !imageEditingCapability.available) return;
    const capturedRegions = [...imageRegions];
    const captured = normalizeHeaderParts(headerDraftRef.current);
    if (dirtyRef.current) {
      const saved = await bakeAndSave(captured);
      if (!saved) throw new Error('Save your image edits before starting an AI modification.');
    } else if (headerDirtyRef.current) {
      saveMediaHeaderVersion(nodeId, captured);
    }
    await modifyImageInMediaNode(nodeId, instruction, capturedRegions);
  }, [bakeAndSave, generating, imageEditingCapability.available, nodeId, imageRegions]);

  const askWithAi = useCallback(async (question: string) => {
    if (savingRef.current || generating) return;
    const capturedRegions = [...imageRegions];
    const captured = normalizeHeaderParts(headerDraftRef.current);
    if (dirtyRef.current) {
      const saved = await bakeAndSave(captured);
      if (!saved) throw new Error('Save your image edits before asking a follow-up.');
    } else if (headerDirtyRef.current) saveMediaHeaderVersion(nodeId, captured);
    await askImageFollowUp(nodeId, question, capturedRegions, () => {
      if (useImageEditorStore.getState().nodeId === nodeId) close();
    });
  }, [bakeAndSave, close, generating, imageRegions, nodeId]);

  // ── Editor-internal keys (capture phase, stopped before the app keymap) ──
  useEffect(() => {
    const PAN_KEYS: Record<string, [number, number]> = {
      w: [0, 1],
      s: [0, -1],
      a: [1, 0],
      d: [-1, 0],
    };
    const held = new Set<string>();
    let panRaf: number | null = null;
    const panLoop = () => {
      let ax = 0;
      let ay = 0;
      for (const key of held) {
        const direction = PAN_KEYS[key];
        if (direction) {
          ax += direction[0];
          ay += direction[1];
        }
      }
      let dx = Math.sign(ax);
      let dy = Math.sign(ay);
      if (dx === 0 && dy === 0) {
        panRaf = null;
        return;
      }
      if (dx !== 0 && dy !== 0) {
        dx *= Math.SQRT1_2;
        dy *= Math.SQRT1_2;
      }
      viewportController.panBy(dx * 3, dy * 3);
      panRaf = requestAnimationFrame(panLoop);
    };
    const stopKeyboardPan = () => {
      if (panRaf !== null) cancelAnimationFrame(panRaf);
      panRaf = null;
      held.clear();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (editingRef.current) return; // the inline text field owns its keys
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
      if (inField) {
        // Escape while typing exits the FIELD, not the editor (closing here
        // used to run before this check and threw away in-progress typing).
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          t.blur();
        }
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        viewportController.setSpaceHeld(true);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (canvasRef.current?.clearImageSelection()) { e.stopImmediatePropagation(); return; }
        void doClose();
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.toLowerCase() === 'q' || e.key.toLowerCase() === 'e')) {
        e.preventDefault();
        e.stopPropagation();
        viewportController.animateZoomBy(e.key.toLowerCase() === 'e'
          ? IMAGE_EDITOR_ZOOM_STEP
          : 1 / IMAGE_EDITOR_ZOOM_STEP);
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const key = e.key.toLowerCase();
        if (PAN_KEYS[key]) {
          e.preventDefault();
          e.stopPropagation();
          held.add(key);
          if (panRaf === null) panRaf = requestAnimationFrame(panLoop);
          return;
        }
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault(); e.stopPropagation(); doUndo(); return;
      }
      if ((mod && e.shiftKey && e.key.toLowerCase() === 'z') || (mod && e.key.toLowerCase() === 'y')) {
        e.preventDefault(); e.stopPropagation(); doRedo(); return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current.length) {
        e.preventDefault();
        e.stopPropagation();
        dispatch({ kind: 'removeElements', ids: selectedRef.current });
        setSelectedIds([]);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        viewportController.setSpaceHeld(false);
        e.stopPropagation();
      }
      if (held.delete(e.key.toLowerCase()) && held.size === 0) {
        if (panRaf !== null) cancelAnimationFrame(panRaf);
        panRaf = null;
        e.stopPropagation();
      }
    };
    const onBlur = () => {
      viewportController.setSpaceHeld(false);
      viewportController.setPanning(false);
      stopKeyboardPan();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      viewportController.setSpaceHeld(false);
      viewportController.setPanning(false);
      stopKeyboardPan();
    };
  }, [doClose, doUndo, doRedo, dispatch, viewportController]);

  // Node deleted while open → bail.
  useEffect(() => {
    if (!node) close();
  }, [node, close]);

  if (!node) return null;
  const total = node.versions.length;
  const present = history.present;

  // Dev aid: expose the live editor document for console inspection.
  if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__scatterImageEditorDoc = present;
  }

  // ── Version handling (text-editor semantics) ─────────────────────────────
  const switchVersion = (delta: -1 | 1) => {
    const next = Math.max(0, Math.min(total - 1, verIdx + delta));
    if (next === verIdx) return;
    if ((dirtyRef.current || headerDirtyRef.current) && !window.confirm('Discard your unsaved edits and switch versions?')) return;
    useGraphStore.getState().updateNode(nodeId, { currentVersionIndex: next });
  };
  const deleteVersion = () => {
    if (total <= 1) return;
    const current = useGraphStore.getState().project?.nodes[nodeId];
    const patch = current && version && removeNodeVersion(current, version.createdAt);
    if (patch) useGraphStore.getState().updateNode(nodeId, patch);
  };

  // ── Setting changes also restyle the current selection ──────────────────
  const patchSelection = (match: (el: AnnotEl) => boolean, patch: Parameters<typeof Object.assign>[1]) => {
    const targets = present.elements.filter((el) => selectedRef.current.includes(el.id) && match(el));
    if (!targets.length) return;
    for (const el of targets) dispatch({ kind: 'updateElement', id: el.id, patch }, true);
    endGesture();
  };
  const changeColor = (c: string) => {
    setColor(c);
    patchSelection(() => true, { color: c });
  };
  const changeStrokeWidth = (w: number) => {
    setStrokeWidth(w);
    // Transient so scrubbing the slider over a selection stays one undo entry
    // (the slider's onDone fires endGesture).
    const targets = present.elements.filter((el) => selectedRef.current.includes(el.id) && el.tool !== 'text');
    for (const el of targets) dispatch({ kind: 'updateElement', id: el.id, patch: { strokeWidth: w } }, true);
  };
  // Font/size changes hit, in priority order: the text currently being edited
  // inline (WITHOUT ending the edit — the field skips its blur-commit for
  // clicks on these controls), then any selected text, and always the default
  // for new text.
  const patchEditedText = (patch: { fontFamily?: string; fontSize?: number }): boolean => {
    const editing = editingRef.current;
    if (!editing) return false;
    dispatch({ kind: 'updateElement', id: editing, patch }, true);
    endGesture();
    return true;
  };
  const changeFont = (id: string) => {
    setFontId(id);
    const family = fontFamilyFor(id);
    void ensureFontLoaded(family).then(() => setFontTick((t) => t + 1));
    if (!patchEditedText({ fontFamily: family })) {
      patchSelection((el) => el.tool === 'text', { fontFamily: family });
    }
  };
  const changeFontSize = (n: number) => {
    setFontSize(n);
    if (!patchEditedText({ fontSize: n })) {
      patchSelection((el) => el.tool === 'text', { fontSize: n });
    }
  };

  const rotate90 = (dir: 1 | -1) => {
    const { w: tw, h: th } = turnedDims(image?.naturalWidth ?? 1, image?.naturalHeight ?? 1, present.crop.quarterTurns);
    dispatch({
      kind: 'setCrop',
      patch: {
        quarterTurns: (((present.crop.quarterTurns + dir) % 4) + 4) % 4 as 0 | 1 | 2 | 3,
        rect: present.crop.rect ? rotateCropForQuarterTurn(present.crop.rect, tw, th, dir) : null,
      },
    });
  };

  const commitText = (id: string, text: string) => {
    setEditingTextId(null);
    if (!text.trim()) {
      // Placing a text box and typing nothing = a void gesture (no undo entry).
      dispatch({ kind: 'removeElements', ids: [id] }, true);
      endGesture();
      setSelectedIds([]);
      return;
    }
    dispatch({ kind: 'updateElement', id, patch: { text } }, true);
    endGesture();
    const el = historyRef.current.present.elements.find((x) => x.id === id) as TextEl | undefined;
    if (el) void ensureFontLoaded(el.fontFamily, text).then(() => setFontTick((t) => t + 1));
  };

  const style: CSSProperties | undefined = accent
    ? { ...groupVars(colorToCss(accent)), '--ie-accent': accentHex ?? undefined } as CSSProperties
    : undefined;

  const statusCard =
    generationError && version?.imageGeneration && !media ? { title: 'Image generation stopped', sub: generationError }
    : phase === 'error' ? { title: 'This image can’t be edited', sub: 'Its host doesn’t allow the browser to read the pixels (a cross-site protection). Download the file and upload it to the node, then edit that copy.' }
    : phase === 'gif' ? { title: 'GIFs can’t be edited', sub: 'Editing would flatten the animation to a single still frame. Switch to another version, or upload a still image.' }
    : phase === 'nomedia' ? { title: 'No editable image here', sub: 'This version has no image attached — use the version arrows on the left to find one.' }
    : !image && loading ? { title: 'Opening image…', sub: 'Loading the picture into the editor.' }
    : null;

  return (
    <>
      <div className="text-editor-backdrop" />
      <div
        className="text-editor-stage image-editor-stage"
        style={style}
        onMouseDown={(e) => { if (e.target === e.currentTarget) void doClose(); }}
      >
        <div
          className="text-editor-group"
          onMouseDown={(e) => { if (e.target === e.currentTarget) void doClose(); }}
        >
          <aside className="text-editor-panel">
            <ImageEditorPanel
              verIdx={verIdx}
              total={total}
              busy={saving || generating}
              ready={ready}
              dirty={dirty || headerDirty}
              tool={tool}
              crop={present.crop}
              color={color}
              accentHex={accentHex}
              strokeWidth={strokeWidth}
              fontId={fontId}
              fontSize={fontSize}
              adjustments={present.adjustments}
              viewportController={viewportController}
              onSwitchVersion={switchVersion}
              onDeleteVersion={deleteVersion}
              onSave={saveAsNew}
              showGenerate={!!version?.imageGeneration}
              generateLabel={regenerateFromHeaderLabel(headerDraft)}
              canGenerate={imageGenerationAvailable && !!semanticHeaderText(headerDraft)}
              onGenerate={() => { void generateFromHeader(); }}
              onTool={(t) => { setTool(t); if (t !== 'select') setSelectedIds([]); }}
              onRotate90={rotate90}
              onFineAngle={(deg) => dispatch({ kind: 'setCrop', patch: { fineAngle: deg } }, true)}
              onClearCrop={() => dispatch({ kind: 'setCrop', patch: { rect: null, fineAngle: 0, quarterTurns: 0 } })}
              onColor={changeColor}
              onStrokeWidth={changeStrokeWidth}
              onFont={changeFont}
              onFontSize={changeFontSize}
              onAdjust={(patch) => dispatch({ kind: 'setAdjustments', patch }, true)}
              onResetAdjust={() => dispatch({ kind: 'setAdjustments', patch: { saturation: 0, warmth: 0, contrast: 0, hue: 0 } })}
              onGestureEnd={endGesture}
              canUndo={canUndo(history)}
              canRedo={canRedo(history)}
              onUndo={doUndo}
              onRedo={doRedo}
            />
          </aside>

          <div className="text-editor-cardwrap image-editor-cardwrap">
            <div
              className={`text-editor-card image-editor-card${generating ? ' is-image-generating' : ''}`}
              role="dialog"
              aria-modal="true"
            >
              <div className="image-editor-header">
                <StructuredHeaderEditor
                  value={headerDraft}
                  onChange={setHeaderDraft}
                  constrained
                  density="compact"
                  disabled={saving || generating}
                  pulsing={generating}
                />
                <button type="button" className="text-editor-exit" onClick={() => void doClose()} data-tip="Exit (Esc) — saves your changes as a new version">
                  <SquareArrowRight size={15} /> Exit
                </button>
              </div>
              <div className="image-editor-media-area">
                {phase === 'generating' && !generationError ? (
                  <GenerationMediaSkeleton kind="image" />
                ) : statusCard ? (
                  <div className="ie-status">
                    <div className="ie-status-title">{statusCard.title}</div>
                    <div className="ie-status-sub">{statusCard.sub}</div>
                  </div>
                ) : image && (
                  <>
                  <ImageEditorCanvas
                    ref={canvasRef}
                    image={image}
                    doc={present}
                    tool={tool}
                    color={color}
                    strokeWidth={strokeWidth}
                    fontFamily={fontFamilyFor(fontId)}
                    fontSize={fontSize}
                    selectedIds={selectedIds}
                    editingTextId={editingTextId}
                    lowRes={history.pendingBase !== null}
                    fontTick={fontTick}
                    viewportController={viewportController}
                    onSelect={setSelectedIds}
                    onDispatch={dispatch}
                    onGestureEnd={endGesture}
                    onEditText={setEditingTextId}
                    onCommitText={commitText}
                    imageRegions={imageRegions}
                    onImageRegions={setImageRegions}
                    imageSelectionDisabled={loading || saving || generating}
                  />
                  {showSpinner && loading && <div className="sc-media-spinner ie-load-spinner" aria-label="Loading" />}
                  </>
                )}
              </div>
            </div>
            {phase !== 'gif' && phase !== 'nomedia' && <ImageEditorBottomBar
              nodeId={nodeId}
              capable={imageEditingCapability.available}
              editable={ready && !loading}
              checking={imageEditingCapability.checking}
              busy={saving || generating}
              onModify={modifyWithAi}
              onAsk={askWithAi}
              selectedPart={imageRegions.length > 0}
            />}
          </div>
        </div>
      </div>
    </>
  );
}

function ImageEditorWindow({ nodeId }: { nodeId: string }) {
  const verIdx = useGraphStore((s) => s.project?.nodes[nodeId]?.currentVersionIndex ?? 0);
  // The session stays mounted across version switches — it resets its own
  // document per version and keeps the old bitmap until the next one loads.
  return <EditorSession nodeId={nodeId} verIdx={verIdx} />;
}

export default function ImageEditorOverlay() {
  const open = useImageEditorStore((s) => s.open);
  const nodeId = useImageEditorStore((s) => s.nodeId);
  if (!open || !nodeId) return null;
  return <ImageEditorWindow key={nodeId} nodeId={nodeId} />;
}
