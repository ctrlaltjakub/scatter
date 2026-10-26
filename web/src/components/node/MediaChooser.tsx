'use client';
import { useEffect, useRef, useState } from 'react';
import { ImageUp, Link2 } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { MEDIA_CHOOSER_W } from '@/lib/mediaSizing';
import { attachMediaFromFile, attachMediaFromLink } from '@/lib/mediaActions';
import { generateImageInMediaNode } from '@/lib/imageGeneration';
import { useImageGenerationAvailable } from '@/hooks/useImageGenerationAvailable';
import type { MediaChooserMode } from './MediaModeToggle';

/**
 * Empty media-node UI. The friendly explainer is rendered ABOVE this (through
 * AdaptiveBullets, from the node's body) so it shares the text settings; this
 * component is the controls + the four ingest paths (link, upload, drag, paste).
 * The empty card is a fixed width (MEDIA_CHOOSER_W) — the explainer wraps in it.
 */
export function MediaChooser({
  nodeId,
  mode = 'attach',
}: {
  nodeId: string;
  mode?: MediaChooserMode;
}) {
  const [link, setLink] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageError, setImageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageAvailable = useImageGenerationAvailable();

  const selected = useGraphStore((s) => !!s.project?.selection.includes(nodeId));
  const savedPrompt = useGraphStore((s) => {
    const node = s.project?.nodes[nodeId];
    const provenance = node?.versions[node.currentVersionIndex]?.imageGeneration;
    return provenance?.promptSource === 'media-prompt' ? provenance.prompt : '';
  });

  useEffect(() => {
    setImagePrompt(savedPrompt);
  }, [savedPrompt]);

  // The empty media node is a fixed width. Normalise any node that was saved at
  // a different (older, text-measured) width back to the constant on mount.
  useEffect(() => {
    const g = useGraphStore.getState();
    const node = g.project?.nodes[nodeId];
    if (!node) return;
    const curW = node.versions[node.currentVersionIndex]?.width;
    if (Math.abs((curW ?? 0) - MEDIA_CHOOSER_W) > 1) {
      useGraphStore.temporal.getState().pause();
      try { g.setVersionSize(nodeId, { width: MEDIA_CHOOSER_W }); }
      finally { useGraphStore.temporal.getState().resume(); }
    }
  }, [nodeId]);

  const runAttach = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setImageError(null);
    try { await fn(); }
    catch (error) { setImageError(error instanceof Error ? error.message : 'Could not add this file or link. Try another one.'); }
    finally { setBusy(false); }
  };

  const onAddLink = () => {
    const v = link.trim();
    if (!v) return;
    void runAttach(() => attachMediaFromLink(nodeId, v));
  };

  const onGenerateImage = () => {
    const prompt = imagePrompt.trim();
    if (!prompt || busy || !imageAvailable) return;
    setImageError(null);
    setBusy(true);
    void generateImageInMediaNode(nodeId, prompt)
      .catch((error: unknown) => setImageError(error instanceof Error ? error.message : 'Could not start image generation.'))
      .finally(() => setBusy(false));
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) void runAttach(() => attachMediaFromFile(nodeId, f));
  };

  // ── Drag a file onto the card.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (mode !== 'attach') return;
    const f = e.dataTransfer?.files?.[0];
    if (f) void runAttach(() => attachMediaFromFile(nodeId, f));
  };

  // ── Paste an image while this empty media node is selected.
  useEffect(() => {
    if (!selected || mode !== 'attach') return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      let file: File | null = null;
      if (items) {
        for (const it of Array.from(items)) {
          if (it.kind === 'file' && it.type.startsWith('image/')) { file = it.getAsFile(); break; }
        }
      }
      if (!file) return;
      e.preventDefault();
      const f = file;
      void runAttach(() => attachMediaFromFile(nodeId, f));
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, nodeId, mode]);

  return (
    <div
      className={'sc-media-chooser' + (dragOver ? ' sc-media-droptarget' : '')}
      onPointerDown={(e) => e.stopPropagation()}
      onDragOver={(e) => { if (mode === 'attach') { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {mode === 'generate' ? <div className={`sc-media-image-generator${imageAvailable ? '' : ' is-disabled'}`}>
        <textarea
          className="sc-media-image-prompt"
          aria-label="Describe the image to generate"
          placeholder="Describe the image you want to generate…"
          value={imagePrompt}
          onChange={(event) => { setImagePrompt(event.target.value); setImageError(null); }}
          rows={2}
          disabled={busy || !imageAvailable}
        />
        <button
          type="button"
          className="sc-media-generate"
          disabled={busy || !imagePrompt.trim() || !imageAvailable}
          data-tip={!imageAvailable ? 'Choose an image model in Settings → Models and generation.' : 'Generate an image from this prompt'}
          onClick={onGenerateImage}
        >
          Generate image
        </button>
      </div> : (
        <div className="sc-media-attach-options">
          <div className="sc-media-attach-top">
            <div className="sc-media-field">
              <Link2 size={14} className="sc-media-field-icon" aria-hidden="true" />
              <input
                type="url"
                className="sc-media-input"
                placeholder="Paste an image, GIF, or video link…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAddLink(); } }}
                aria-label="Image, GIF, or video link"
                disabled={busy}
              />
            </div>
            <button type="button" className="sc-media-btn" onClick={onAddLink} disabled={busy || !link.trim()}>
              Add
            </button>
          </div>
          <button type="button" className="sc-media-upload" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <ImageUp size={15} />
            <span>Upload a file…</span>
          </button>
        </div>
      )}
      {imageError && <p className="sc-media-image-error">{imageError}</p>}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/mp4,video/webm"
        style={{ display: 'none' }}
        onChange={onFileChange}
      />
      {busy && <div className="sc-media-spinner" aria-label="Loading" />}
    </div>
  );
}
