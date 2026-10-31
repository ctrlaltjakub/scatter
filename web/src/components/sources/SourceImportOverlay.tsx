'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cloud, FilePlus2, FileText, Globe2, Link2, SquareArrowRight, Trash2, Upload } from 'lucide-react';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { useGraphStore } from '@/store/useGraphStore';
import { createScatter } from '@/store/projectActions';
import { addPastedSource, addSourceFiles, addWebpageSources } from '@/lib/sourceProcessing';
import { sourceKindForFile } from '@/lib/sourceExtraction';
import { pickGoogleDriveSourceFiles } from '@/lib/googleDriveSourcePicker';

type Tab = 'files' | 'links' | 'text';
interface QueuedFile { id: string; file: File }
interface PendingDriveFile { id: string; name: string }

function splitUrls(value: string): { valid: string[]; invalid: string[] } {
  const candidates = value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
      valid.push(url.href);
    } catch { invalid.push(candidate); }
  }
  return { valid: [...new Set(valid)], invalid };
}

function proposedTitle(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 80) || 'Pasted text';
}

export function SourceImportOverlay({ attachment }: { attachment?: {
  onClose: () => void;
  onConfirm: (files: File[], progress: (message: string) => void) => Promise<void>;
} } = {}) {
  const sourceOpen = useSourceUiStore((state) => state.importOpen);
  const closeSource = useSourceUiStore((state) => state.closeImport);
  const open = !!attachment || sourceOpen;
  const close = attachment?.onClose ?? closeSource;
  const openManager = useSourceUiStore((state) => state.openManager);
  const project = useGraphStore((state) => state.project);
  const pickerOpen = useGraphStore((state) => state.pickerOpen);
  const [tab, setTab] = useState<Tab>('files');
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [pendingDriveFiles, setPendingDriveFiles] = useState<PendingDriveFile[]>([]);
  const [links, setLinks] = useState('');
  const [textValue, setTextValue] = useState('');
  const [textTitle, setTextTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [progress, setProgress] = useState('');
  const [pickingDrive, setPickingDrive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activePickerRef = useRef<string | null>(null);
  const parsed = useMemo(() => splitUrls(links), [links]);
  const readyCount = files.length + parsed.valid.length + (textValue.trim() ? 1 : 0);
  const queuedCount = readyCount + pendingDriveFiles.length;

  const addFiles = useCallback((incoming: FileList | readonly File[]) => {
    const accepted = Array.from(incoming).filter((file) => sourceKindForFile(file));
    setFiles((current) => {
      const keys = new Set(current.map(({ file }) => `${file.name}:${file.size}:${file.lastModified}`));
      return [...current, ...accepted.filter((file) => !keys.has(`${file.name}:${file.size}:${file.lastModified}`))
        .map((file) => ({ id: crypto.randomUUID(), file }))];
    });
  }, []);

  const chooseFromDrive = useCallback(async () => {
    if (pickingDrive) return;
    const batchId = crypto.randomUUID();
    let pendingIds: string[] = [];
    activePickerRef.current = batchId;
    setPickingDrive(true);
    setError(null);
    try {
      const incoming = await pickGoogleDriveSourceFiles({
        onSelected: (selected) => {
          pendingIds = selected.map((file) => `${batchId}:${file.id}`);
          setPendingDriveFiles((current) => [
            ...current,
            ...selected.map((file, index) => ({ id: pendingIds[index]!, name: file.name })),
          ]);
          if (activePickerRef.current === batchId) {
            activePickerRef.current = null;
            setPickingDrive(false);
          }
        },
      });
      addFiles(incoming);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (pendingIds.length) {
        const completed = new Set(pendingIds);
        setPendingDriveFiles((current) => current.filter((item) => !completed.has(item.id)));
      }
      if (activePickerRef.current === batchId) {
        activePickerRef.current = null;
        setPickingDrive(false);
      }
    }
  }, [addFiles, pickingDrive]);

  const removeQueuedLink = useCallback((removeUrl: string) => {
    setLinks((current) => current
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter((item) => {
        if (!item) return false;
        try { return new URL(item).href !== removeUrl; } catch { return true; }
      })
      .join('\n'));
  }, []);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !adding) close(); };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [open, adding, close]);

  if (!open) return null;

  const confirm = async () => {
    if (!readyCount || pendingDriveFiles.length || adding) return;
    setAdding(true);
    setError(null);
    try {
      if (attachment) {
        await attachment.onConfirm(files.map(({ file }) => file), setProgress);
        close();
        return;
      }
      // A populated project's topic picker is preparing a new project. Create
      // that empty project only when the user actually commits source input,
      // and mark it as disposable before the import overlay can close.
      if (pickerOpen && project && Object.keys(project.nodes).length > 0) {
        const returnProjectId = project.id;
        const projectId = await createScatter();
        useSourceUiStore.getState().setTopicDraft({ projectId, returnProjectId });
      }
      const projectId = useGraphStore.getState().activeProjectId;
      if (!projectId) throw new Error('No project is available for these sources.');
      await Promise.all([
        files.length ? addSourceFiles(projectId, files.map(({ file }) => file)) : Promise.resolve([]),
        parsed.valid.length ? addWebpageSources(projectId, parsed.valid) : Promise.resolve([]),
        textValue.trim() ? addPastedSource(projectId, textTitle.trim() || proposedTitle(textValue), textValue) : Promise.resolve(''),
      ]);
      setFiles([]); setLinks(''); setTextValue(''); setTextTitle('');
      close();
      openManager();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="text-editor-backdrop source-import-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !adding) close();
    }}>
      <section className="source-import-window" role="dialog" aria-modal="true" aria-label={attachment ? 'Attach files to message' : 'Add project sources'} onPointerDown={(event) => event.stopPropagation()}>
        <header className="source-import-head">
          <div><strong>{attachment ? 'Attach files' : 'Add sources'}</strong><span>{attachment ? 'Images and documents for this message' : 'Files, webpages, or text for this project'}</span></div>
          <button type="button" className="text-editor-exit" onClick={close} disabled={adding}><SquareArrowRight size={15} /> Exit</button>
        </header>
        {!attachment && <div className="source-import-tabs" role="tablist" aria-label="Source type">
          <button type="button" role="tab" aria-selected={tab === 'files'} aria-controls="source-import-files" className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><FilePlus2 size={15} /> Files</button>
          <button type="button" role="tab" aria-selected={tab === 'links'} aria-controls="source-import-links" className={tab === 'links' ? 'active' : ''} onClick={() => setTab('links')}><Globe2 size={15} /> Web links</button>
          <button type="button" role="tab" aria-selected={tab === 'text'} aria-controls="source-import-text" className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}><FileText size={15} /> Paste text</button>
        </div>}
        <div className="source-import-layout">
          <div className="source-import-input">
            {tab === 'files' && (
              <div
                id="source-import-files"
                role="tabpanel"
                className="source-drop-zone"
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
                onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}
                onPaste={(event) => addFiles(event.clipboardData.files)}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    inputRef.current?.click();
                  }
                }}
                tabIndex={0}
              >
                <Upload size={30} />
                <strong>Drop or paste files here</strong>
                <span>{attachment ? 'PDF, DOCX, TXT, Markdown, PNG, JPG, and WebP' : 'PDF, DOCX, TXT, Markdown, and images'}</span>
                <div>
                  <button type="button" onClick={() => inputRef.current?.click()}><Upload size={15} /> Choose files</button>
                  <button type="button" onClick={() => { void chooseFromDrive(); }} disabled={pickingDrive} data-tip="Choose specific files from Google Drive"><Cloud size={15} /> {pickingDrive ? 'Opening…' : 'Google Drive'}</button>
                </div>
                <input ref={inputRef} hidden multiple type="file" accept={attachment ? '.pdf,.docx,.txt,.md,.markdown,image/png,image/jpeg,image/webp' : '.pdf,.docx,.txt,.md,.markdown,image/*'} onChange={(event) => event.target.files && addFiles(event.target.files)} />
              </div>
            )}
            {tab === 'links' && (
              <label id="source-import-links" role="tabpanel" className="source-import-field">
                <span>One or several webpage links</span>
                <textarea value={links} onChange={(event) => setLinks(event.target.value)} placeholder={'https://example.org/article\nhttps://another.example/page'} autoFocus />
                {parsed.invalid.length > 0 && <small className="source-import-error">Check: {parsed.invalid.slice(0, 3).join(', ')}</small>}
              </label>
            )}
            {tab === 'text' && (
              <div id="source-import-text" role="tabpanel" className="source-paste-fields">
                <label className="source-import-field source-title-field"><span>Source title</span><input value={textTitle} onChange={(event) => setTextTitle(event.target.value)} placeholder={proposedTitle(textValue)} /></label>
                <label className="source-import-field"><span>Plain text</span><textarea value={textValue} onChange={(event) => { setTextValue(event.target.value); if (!textTitle) setTextTitle(proposedTitle(event.target.value)); }} placeholder="Paste source text…" autoFocus /></label>
              </div>
            )}
          </div>
          <aside className="source-import-queue" aria-live="polite">
            <h3>Ready to add <span>{queuedCount}</span></h3>
            {files.map(({ id, file }) => (
              <div className="source-queue-row" key={id}><FileText size={14} /><span><strong>{file.name}</strong><small>{Math.max(1, Math.round(file.size / 1024))} KB</small></span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item.id !== id))}><Trash2 size={14} /></button></div>
            ))}
            {pendingDriveFiles.map(({ id, name }) => (
              <div className="source-queue-row source-queue-row--loading" key={id} role="status" aria-label={`Preparing ${name}`}>
                <Cloud size={14} />
                <span aria-hidden="true"><i /><i /></span>
              </div>
            ))}
            {parsed.valid.map((url) => (
              <div className="source-queue-row" key={url}><Link2 size={14} /><span><strong>{new URL(url).hostname}</strong><small>{url}</small></span><button type="button" onClick={() => removeQueuedLink(url)} aria-label={`Remove ${url}`}><Trash2 size={14} /></button></div>
            ))}
            {textValue.trim() && <div className="source-queue-row"><FileText size={14} /><span><strong>{textTitle || proposedTitle(textValue)}</strong><small>{textValue.trim().length.toLocaleString()} character{textValue.trim().length === 1 ? '' : 's'}</small></span><button type="button" onClick={() => { setTextValue(''); setTextTitle(''); }} aria-label="Remove pasted text"><Trash2 size={14} /></button></div>}
            {!queuedCount && <p>Add a mixed batch, then confirm it once.</p>}
          </aside>
        </div>
        {error && <div className="source-import-error" role="alert">{error}</div>}
        {adding && attachment && <div className="chat-attachment-progress" role="status">{progress || 'Preparing files…'}</div>}
        <footer className="source-import-footer">
          <p className="source-import-privacy-note">
            {attachment ? 'These files are attached to this message, not added to project sources. Their contents may remain in this conversation’s context. Images go to your selected AI provider; scanned documents use AI text extraction. For searchable references across the project, add project sources instead.' : 'Blocked sites may be read through Jina Reader. Images and scanned pages are sent to your selected AI provider for text extraction. Source search and indexing happen locally.'}
          </p>
          <div className="source-import-footer-actions">
            {attachment && <button type="button" disabled={adding} onClick={() => {
              close(); useSourceUiStore.getState().openManager(); useSourceUiStore.getState().openImport();
            }}>Add project sources instead</button>}
            <button type="button" onClick={close} disabled={adding}>Cancel</button>
            <button type="button" className="primary" disabled={!readyCount || pendingDriveFiles.length > 0 || parsed.invalid.length > 0 || adding} onClick={() => { void confirm(); }}>
              {adding
                ? 'Adding…'
                : pendingDriveFiles.length
                  ? `Preparing ${pendingDriveFiles.length} file${pendingDriveFiles.length === 1 ? '' : 's'}…`
                : attachment ? `Attach ${readyCount} file${readyCount === 1 ? '' : 's'}` : `Add ${readyCount} source${readyCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
