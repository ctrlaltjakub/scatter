'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, Scan, Monitor, MousePointer2, X, LoaderCircle } from 'lucide-react';
import { useScreenshotStore } from '@/store/useScreenshotStore';
import { captureAppScreenshot, screenshotDimensions, type CaptureRect } from '@/lib/appScreenshot';
import { downloadBlob } from '@/lib/download';
import styles from './ScreenshotTool.module.css';

export default function ScreenshotTool() {
  const open = useScreenshotStore(state => state.open);
  const close = () => useScreenshotStore.getState().setOpen(false);
  const [selection, setSelection] = useState<CaptureRect | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [pointer, setPointer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = useRef<{ x: number; y: number } | null>(null);
  const lastPointer = useRef({ x: 0, y: 0 });
  const captureRef = useRef<() => void>(() => {});
  const capture = async () => {
    if (busy || selecting) return;
    setBusy(true); setError('');
    try {
      const bounds = selection ?? { x: 0, y: 0, width: innerWidth, height: innerHeight };
      const blob = await captureAppScreenshot(bounds, pointer ? lastPointer.current : undefined);
      downloadBlob(blob, `scatter-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  captureRef.current = () => { void capture(); };
  useEffect(() => {
    if (!open) return;
    const move = (event: PointerEvent) => {
      if (!(event.target as Element)?.closest('[data-sc-capture-exclude]')) lastPointer.current = { x: event.clientX, y: event.clientY };
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopImmediatePropagation(); setSelecting(false); close(); }
      const editing = event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
      if (event.key === '=' && !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey
        && !event.repeat && !event.isComposing && !editing) {
        event.preventDefault(); event.stopImmediatePropagation(); captureRef.current();
      }
    };
    const resize = () => { setSelection(null); setSelecting(false); };
    window.addEventListener('pointermove', move); window.addEventListener('keydown', key, true); window.addEventListener('resize', resize);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', resize); };
  }, [open, busy]);
  if (!open) return null;
  const dimensions = selection ? screenshotDimensions(selection) : null;
  return <div data-sc-capture-exclude="" className={styles.root}>
    <div className={styles.toolbar} role="toolbar" aria-label="Screenshot capture">
      <span className={styles.title}>Screenshot</span>
      <button aria-pressed={!selection && !selecting} disabled={busy} data-tip="Capture the whole app" onClick={() => { setSelection(null); setSelecting(false); }}><Monitor size={17} />Whole app</button>
      <button aria-pressed={!!selection || selecting} disabled={busy} data-tip="Drag a rectangle to choose the capture area" onClick={() => { setSelection(null); setSelecting(true); setError(''); }}><Scan size={17} />Select area</button>
      <button aria-pressed={pointer} disabled={busy} data-tip="Include a vector mouse pointer at its last position outside this toolbar" onClick={() => setPointer(value => !value)}><MousePointer2 size={17} />Capture pointer</button>
      <span className={styles.size}>{dimensions ? `${dimensions.width} × ${dimensions.height}` : '2560 px long edge'}</span>
      <button className={styles.capture} disabled={busy || selecting} data-tip="Save a high-resolution PNG (=). The toolbar is excluded." onClick={() => void capture()}>{busy ? <LoaderCircle className={styles.spinner} size={17} /> : <Camera size={17} />}{busy ? 'Rendering…' : 'Capture'}</button>
      <button aria-label="Close screenshot tool" disabled={busy} data-tip="Close screenshot tool (Esc)" onClick={close}><X size={17} /></button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
    {selecting && <div className={styles.selector} aria-label="Drag to select screenshot area"
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start.current = { x: event.clientX, y: event.clientY }; }}
      onPointerMove={event => { if (!start.current) return; const a = start.current; setSelection({ x: Math.min(a.x, event.clientX), y: Math.min(a.y, event.clientY), width: Math.max(1, Math.abs(event.clientX - a.x)), height: Math.max(1, Math.abs(event.clientY - a.y)) }); }}
      onPointerUp={() => { start.current = null; setSelecting(false); }} onPointerCancel={() => { start.current = null; setSelecting(false); }} />}
    {selection && <div className={styles.selection} style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />}
  </div>;
}
