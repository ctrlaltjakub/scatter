'use client';

import { useId, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { newId } from '@/lib/ids';
import { BUILTIN_SEARCH_ENGINES, selectedSearchEngine, selectionSearchUrl, searchTemplateError } from '@/lib/selectionWebSearch';
import { SettingsSection } from './SettingsSection';

type Draft = { id: string | null; name: string; urlTemplate: string };

export function SelectionWebSearchSettings() {
  const settings = useSettingsStore(state => state.selectionWebSearch);
  const update = useSettingsStore(state => state.setSelectionWebSearch);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const id = useId();
  const selected = selectedSearchEngine(settings);
  const custom = settings.customEngines.find(engine => engine.id === selected.id);
  const nameError = draft && (!draft.name.trim() ? 'Enter a name for this search engine.'
    : draft.name.trim().length > 80 ? 'Use 80 characters or fewer for the name.' : null);
  const error = nameError || (draft && searchTemplateError(draft.urlTemplate));
  const preview = draft ? selectionSearchUrl('hello world', draft.urlTemplate) : null;

  return (
    <SettingsSection title="Text selection web search" description={<>Search <strong>selected text in a new browser tab</strong>. This is separate from AI web search and uses <strong>no model or API key</strong>.</>}>
      <div className="field-row">
        <label className="field-label" htmlFor={`${id}-engine`}>Search engine</label>
        <select id={`${id}-engine`} className="input" value={selected.id} onChange={event => {
          update({ ...settings, engineId: event.target.value });
          setDraft(null); setSubmitted(false);
        }}>
          {BUILTIN_SEARCH_ENGINES.map(engine => <option key={engine.id} value={engine.id}>{engine.name}{engine.id === 'google' ? ' (default)' : ''}</option>)}
          {settings.customEngines.length > 0 && <optgroup label="Custom engines">
            {settings.customEngines.map(engine => <option key={engine.id} value={engine.id}>{engine.name}</option>)}
          </optgroup>}
        </select>
      </div>
      <p className="field-help">Select text in a node or its editor, then choose <strong>Web search</strong>. Only the <strong>selected text</strong> is sent to the search website.</p>
      <div className="settings-search-actions">
        <button type="button" className="btn btn-secondary" onClick={() => {
          setDraft({ id: null, name: '', urlTemplate: '' }); setSubmitted(false);
        }}><Plus size={14} aria-hidden="true" /> Add custom engine</button>
        {custom && <>
          <button type="button" className="btn btn-secondary" onClick={() => {
            setDraft({ ...custom }); setSubmitted(false);
          }}><Pencil size={14} aria-hidden="true" /> Edit engine</button>
          <button type="button" className="btn btn-secondary" onClick={() => {
            update({ engineId: 'google', customEngines: settings.customEngines.filter(engine => engine.id !== custom.id) });
            setDraft(null); setSubmitted(false);
          }}><Trash2 size={14} aria-hidden="true" /> Remove engine</button>
        </>}
      </div>
      {draft && <form className="settings-search-form" aria-label={draft.id ? 'Edit search engine' : 'Add search engine'} onSubmit={event => {
        event.preventDefault(); setSubmitted(true);
        if (error) return;
        const engine = { id: draft.id ?? `custom-${newId()}`, name: draft.name.trim(), urlTemplate: draft.urlTemplate.trim() };
        update({
          engineId: engine.id,
          customEngines: settings.customEngines.some(item => item.id === engine.id)
            ? settings.customEngines.map(item => item.id === draft.id ? engine : item)
            : [...settings.customEngines, engine],
        });
        setDraft(null); setSubmitted(false);
      }}>
        <h4>{draft.id ? 'Edit search engine' : 'Add a custom search engine'}</h4>
        <div className="field-row">
          <label className="field-label" htmlFor={`${id}-name`}>Engine name</label>
          <input id={`${id}-name`} className="input" value={draft.name} maxLength={80} autoFocus
            aria-invalid={submitted && !!nameError} aria-describedby={submitted && nameError ? `${id}-error` : undefined}
            placeholder="My search engine" onChange={event => setDraft({ ...draft, name: event.target.value })} />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor={`${id}-url`}>Search URL</label>
          <input id={`${id}-url`} className="input" value={draft.urlTemplate} maxLength={2048}
            autoComplete="off" spellCheck={false} placeholder="https://example.com/search?q={query}"
            aria-describedby={`${id}-help${submitted && error ? ` ${id}-error` : ''}`}
            aria-invalid={submitted && !!searchTemplateError(draft.urlTemplate)}
            onChange={event => setDraft({ ...draft, urlTemplate: event.target.value })} />
        </div>
        <p className="field-help" id={`${id}-help`}>
          Copy a <strong>search-results address</strong> from the website.
          Replace its searched words with <strong><code>{'{query}'}</code></strong> in the path or parameters.
          The app safely encodes spaces and special characters.
          Other parameters, such as language, stay unchanged.
        </p>
        <p className="field-help">
          Search engines requiring a <strong>form submission</strong> instead of a URL are not supported.{' '}
          <strong>Do not include passwords or API keys</strong>: this URL is saved, exported, and synced with your settings.
        </p>
        {preview && <div className="settings-search-preview"><span>Example for “hello world”</span><code>{preview}</code></div>}
        {submitted && error && <p id={`${id}-error`} className="field-help settings-search-error" role="alert">{error}</p>}
        <div className="settings-search-actions">
          <button type="submit" className="btn btn-primary">{draft.id ? 'Save changes' : 'Add and use engine'}</button>
          <button type="button" className="btn btn-secondary" onClick={() => { setDraft(null); setSubmitted(false); }}>Cancel</button>
        </div>
      </form>}
    </SettingsSection>
  );
}
