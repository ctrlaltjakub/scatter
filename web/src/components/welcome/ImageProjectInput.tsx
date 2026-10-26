'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ImageUp, Link2, X } from 'lucide-react';
import { prepareProjectImage, type ProjectStartImage } from '@/lib/projectStart';

export function ImageProjectInput({ active, busy, onStart }: {
  active: boolean; busy: boolean; onStart: (image: ProjectStartImage) => void;
}) {
  const [link, setLink] = useState('');
  const [image, setImage] = useState<ProjectStartImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const job = useRef<AbortController>();
  useEffect(() => () => job.current?.abort(), []);
  useEffect(() => () => { if (image?.file) URL.revokeObjectURL(image.previewUrl); }, [image]);

  const prepare = useCallback(async (value: File | string) => {
    if (busy) return;
    job.current?.abort();
    const controller = new AbortController(); job.current = controller;
    setLoading(true); setError('');
    try {
      const next = await prepareProjectImage(value, controller.signal);
      if (controller.signal.aborted) { if (next.file) URL.revokeObjectURL(next.previewUrl); return; }
      setImage(next);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load the image.');
    } finally { if (job.current === controller) setLoading(false); }
  }, [busy]);

  useEffect(() => {
    if (!active || busy) return;
    const paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      // An open source importer owns its own paste interaction.
      if (event.target instanceof Element && event.target.closest('.welcome-source-pane, .source-import-overlay, [role="dialog"]')) return;
      const file = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith('image/'));
      if (file) { event.preventDefault(); void prepare(file); }
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [active, busy, prepare]);

  return <div className="image-project-input" hidden={!active}>
    <div className={`image-project-dropzone${dragging ? ' is-dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault(); setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) void prepare(file);
      }}>
      {image ? <>
        {/* Local object URLs and user image links use the same native rendering as MediaView. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image.previewUrl} alt={image.title} className="image-project-preview" />
        <button type="button" className="icon-btn image-project-remove" aria-label="Remove image" disabled={busy || loading}
          onClick={() => { setImage(null); setError(''); }}><X size={16} /></button>
        <span className="image-project-name">{image.title}</span>
      </> : <>
        <ImageUp size={32} strokeWidth={1.3} aria-hidden="true" />
        <strong>Start with a picture</strong>
        <span>Drop an image here, paste one, or upload a file.</span>
      </>}
      <button type="button" className="btn btn-secondary" disabled={busy || loading} onClick={() => input.current?.click()}>
        <ImageUp size={16} /> {image ? 'Choose another image' : 'Upload an image'}
      </button>
    </div>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/avif,image/svg+xml"
      aria-label="Upload image file" hidden onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) void prepare(file);
      }} />
    <div className="image-project-link">
      <div className="sc-media-field"><Link2 size={16} className="sc-media-field-icon" aria-hidden="true" />
        <input className="sc-media-input" type="url" aria-label="Image link" placeholder="Paste an image link…"
          value={link} disabled={busy || loading} onChange={(event) => setLink(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (link.trim()) void prepare(link); } }} />
      </div>
      <button type="button" className="btn btn-secondary" disabled={busy || loading || !link.trim()} onClick={() => void prepare(link)}>Add image</button>
    </div>
    {error && <p className="image-project-error" role="alert">{error}</p>}
    <div className="image-project-footer">
      <span role="status">{loading ? 'Loading image…' : 'Your image becomes the first node in this project.'}</span>
      <button type="button" className="btn btn-primary" disabled={!image || loading || busy} onClick={() => { if (image) onStart(image); }}>
        {busy ? 'Starting…' : 'Start project'} <ArrowRight size={16} />
      </button>
    </div>
  </div>;
}
