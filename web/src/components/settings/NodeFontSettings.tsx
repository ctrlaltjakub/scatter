'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { FontDropdown } from '@/components/FontDropdown';
import { APP_FONT_EX_HEIGHT_RATIO, APP_FONT_ID, NODE_TEXT_FONTS, fontFamilyFor } from '@/lib/imageEditFonts';
import { CUSTOM_FONT_ACCEPT, fontByteLabel, isCustomFontId } from '@/lib/customNodeFonts';
import { loadCustomNodeFont, readCustomNodeFont } from '@/lib/customNodeFontRuntime';
import { useSettingsStore } from '@/store/useSettingsStore';

const fontStyle = (id: string) => ({
  fontFamily: fontFamilyFor(id),
  fontSizeAdjust: id === APP_FONT_ID ? 'none' : String(APP_FONT_EX_HEIGHT_RATIO),
});

export function NodeFontSettings() {
  const id = useId();
  const nodeFontId = useSettingsStore(s => s.nodeFontId);
  const fonts = useSettingsStore(s => s.customNodeFonts);
  const setNodeFontId = useSettingsStore(s => s.setNodeFontId);
  const input = useRef<HTMLInputElement>(null);
  const importing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const selectedFile = fonts.find(font => font.id === nodeFontId);

  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    if (isCustomFontId(nodeFontId)) {
      void loadCustomNodeFont(nodeFontId).catch(() => {
        if (!cancelled) setLoadError('This font could not be loaded. A readable fallback is being used. Remove and upload the file again, or choose another font.');
      });
    }
    return () => { cancelled = true; };
  }, [nodeFontId, selectedFile?.data]);

  const upload = async (files: File[]) => {
    if (importing.current || files.length === 0) return;
    importing.current = true;
    setBusy(true); setError(''); setNotice('');
    let added = 0;
    let duplicates = 0;
    const failures: string[] = [];
    try {
      for (const file of files) {
        try {
          const font = await readCustomNodeFont(file);
          const settings = useSettingsStore.getState();
          if (settings.customNodeFonts.some(existing => existing.id === font.id || existing.data === font.data)) {
            duplicates += 1;
          } else {
            settings.addCustomNodeFont(font);
            added += 1;
          }
        } catch (cause) {
          failures.push(`${file.name}: ${cause instanceof Error ? cause.message : 'Could not read the font file.'}`);
        }
      }
      setNotice([added ? `Added ${added} ${added === 1 ? 'font' : 'fonts'}. Select Use to apply.` : '',
        duplicates ? `${duplicates === 1 ? 'This font is' : 'These fonts are'} already in your list.` : ''].filter(Boolean).join(' '));
      setError(failures.join('\n'));
    } finally {
      importing.current = false;
      setBusy(false);
    }
  };

  const options = [
    ...NODE_TEXT_FONTS.map(font => ({ id: font.id, label: font.label, sub: font.description, labelStyle: fontStyle(font.id) })),
    ...fonts.map(font => ({ id: font.id, label: font.name, sub: `Custom font · ${font.format.toUpperCase()} · ${fontByteLabel(font.byteLength)}`, labelStyle: fontStyle(font.id) })),
  ];
  const choose = (id: string) => { setNodeFontId(id); setNotice(''); };
  return <div className="settings-node-fonts" role="group" aria-labelledby={`${id}-heading`} aria-describedby={`${id}-scope`}>
    <div className="settings-reading-subheading">
      <h4 id={`${id}-heading`}>Font</h4>
      <p id={`${id}-scope`}>Used for <strong>node titles and text</strong>, including chats. If the font does not support the language, a readable fallback is used for the <strong>whole node or chat answer</strong>.</p>
    </div>
    <div className="node-font-setting">
      <div className="settings-font-controls">
        <FontDropdown value={nodeFontId} valueLabel={options.find(font => font.id === nodeFontId)?.label ?? NODE_TEXT_FONTS[0]!.label}
          valueStyle={fontStyle(nodeFontId)} options={options} tip="Typeface for node titles and reading text"
          ariaLabel="Reading font" onPick={choose} />
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => input.current?.click()}>
          <Upload size={14} aria-hidden="true" />{busy ? 'Loading fonts…' : 'Upload fonts'}
        </button>
      </div>
      <input ref={input} hidden type="file" multiple accept={CUSTOM_FONT_ACCEPT} aria-label="Upload custom font files"
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(files); }} />
    </div>
    <div className="settings-custom-fonts">
      {fonts.length > 0 && <h5 className="settings-custom-font-heading">Uploaded fonts</h5>}
      {fonts.length > 0 && <ul className="settings-custom-font-list" aria-label="Uploaded fonts">
        {fonts.map(font => <li key={font.id}>
          <div className="settings-custom-font-row">
            <input key={`${font.id}:${font.name}`} className="input settings-custom-font-name" aria-label={`Font name: ${font.name}`} maxLength={80}
              defaultValue={font.name} style={fontStyle(font.id)}
              onBlur={event => {
                const name = event.currentTarget.value.trim();
                if (name) useSettingsStore.getState().renameCustomNodeFont(font.id, name);
                else event.currentTarget.value = font.name;
              }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
            <span className="settings-custom-font-meta">{font.format.toUpperCase()} · {fontByteLabel(font.byteLength)}</span>
            <button type="button" className="btn btn-secondary" aria-pressed={font.id === nodeFontId}
              aria-label={`Use ${font.name}`} onClick={() => choose(font.id)}>{font.id === nodeFontId ? 'In use' : 'Use'}</button>
            <button type="button" className="btn btn-ghost" aria-label={`Remove ${font.name}`} onClick={() => {
              useSettingsStore.getState().removeCustomNodeFont(font.id); setNotice('');
            }}><Trash2 size={14} aria-hidden="true" /></button>
          </div>
        </li>)}
      </ul>}
      <div className="settings-custom-font-notes">
        <span className="settings-custom-font-count">Custom fonts · {fonts.length}/20</span>
        <p className="field-help"><strong>TTF, OTF, WOFF, WOFF2</strong> · 10 MB per file, 20 MB total. Font files are included in <strong>settings exports and sync</strong>. Only upload fonts licensed for embedding and syncing.</p>
      </div>
      {notice && <p className="field-help" role="status">{notice}</p>}
      {(error || loadError) && <p className="settings-inline-error settings-custom-font-error" role="alert">{error || loadError}</p>}
    </div>
  </div>;
}
