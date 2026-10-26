'use client';
import { useState } from 'react';
import { RotateCcw, Copy, Check } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_PROMPTS } from '@/lib/promptDefaults';
import { PROMPT_CATALOG, PROMPT_KEYS, PROMPT_GROUP_ORDER } from '@/lib/promptCatalog';
import type { CustomPrompts } from '@/store/types';
import { CollapsibleSection } from './CollapsibleSection';
import { CopyButton } from './CopyButton';
import { SettingsCopy } from '../settings/SettingsCopy';

export const FIELD_LABELS = Object.fromEntries(PROMPT_KEYS.map(key => [key, PROMPT_CATALOG[key].label])) as Record<keyof CustomPrompts, string>;
export const FIELD_DESCRIPTIONS = Object.fromEntries(PROMPT_KEYS.map(key => [key, PROMPT_CATALOG[key].description])) as Record<keyof CustomPrompts, string>;
const PROMPT_GROUPS = PROMPT_GROUP_ORDER.map(title => ({ title, fields: PROMPT_KEYS.filter(key => PROMPT_CATALOG[key].group === title) }));

export function PromptsEditor() {
  const customPrompts = useSettingsStore((s) => s.customPrompts);
  const setCustomPromptField = useSettingsStore((s) => s.setCustomPromptField);
  const resetCustomPromptField = useSettingsStore((s) => s.resetCustomPromptField);
  const resetAllCustomPrompts = useSettingsStore((s) => s.resetAllCustomPrompts);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState('');
  const groups = PROMPT_GROUPS.map((group) => ({
    ...group,
    fields: group.fields.filter((key) =>
      `${group.title} ${FIELD_LABELS[key]} ${FIELD_DESCRIPTIONS[key].replaceAll('**', '')} ${key}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ),
  })).filter((group) => group.fields.length);

  /** Copy effective prompts (custom override OR default for each field) to
   *  the clipboard as pretty-printed JSON. Lets the user share their full
   *  current prompt set. */
  const handleCopyAll = async () => {
    const effective = (Object.keys(FIELD_LABELS) as (keyof CustomPrompts)[]).reduce(
      (acc, k) => {
        acc[k] = customPrompts?.[k] ?? DEFAULT_PROMPTS[k];
        return acc;
      },
      {} as Record<keyof CustomPrompts, string>,
    );
    const text = JSON.stringify(effective, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('[PromptsEditor] copy failed', e);
    }
  };

  return (
    <>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}
      >
        <div style={{ fontWeight: 600, fontSize: 13 }}>Prompt library · {PROMPT_KEYS.length} prompts</div>
        <button
          type="button"
          onClick={handleCopyAll}
          title="Copy all effective prompts as JSON"
          aria-label="Copy all prompts"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            padding: '3px 8px',
            color: copied ? 'var(--green)' : 'var(--subtext1)',
            background: 'none',
            border: '1px solid var(--ui-line)',
            borderRadius: 'var(--r-sm)',
            cursor: 'var(--cur-click)',
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy all'}
        </button>
      </div>

      <input
        type="search"
        className="input settings-model-search"
        aria-label="Search prompts"
        placeholder="Find a prompt…"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />

      {/* Each prompt is collapsed by default so the editor opens compact; the
          per-field Copy button sits in the header and works while collapsed. */}
      {groups.map((group) => (
        <section key={group.title} className="settings-prompt-group">
          <h4>{group.title}</h4>
          {group.title === 'Advanced format contracts' && <p className="field-help">These prompts define <strong>machine-readable output formats</strong>. Keep their required <strong>field names and markers</strong>. Validation, tool permissions, and sandbox restrictions remain enforced.</p>}
          {group.fields.map((k) => {
            const isCustom = customPrompts?.[k] !== undefined;
            const value = customPrompts?.[k] ?? DEFAULT_PROMPTS[k];
            return (
              <CollapsibleSection
                key={k}
                title={FIELD_LABELS[k] + (isCustom ? ' • edited' : '')}
                description={<SettingsCopy text={FIELD_DESCRIPTIONS[k]} />}
                right={<CopyButton text={value} title="Copy this prompt" />}
              >
                {isCustom && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                    <button
                      type="button"
                      onClick={() => resetCustomPromptField(k)}
                      style={{
                        fontSize: 12,
                        color: 'var(--overlay1)',
                        background: 'none',
                        border: 'none',
                        cursor: 'var(--cur-click)',
                      }}
                    >
                      Reset this field
                    </button>
                  </div>
                )}
                <textarea
                  aria-label={FIELD_LABELS[k]}
                  value={value}
                  onChange={(e) => setCustomPromptField(k, e.target.value)}
                  // Long prompts get a taller default row count so the
                  // initial editor window doesn't make a wall-of-text
                  // template effectively unreadable. The textarea is
                  // still user-resizable (resize: vertical).
                  rows={value.length > 800 ? 12 : 4}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    background: 'var(--base)',
                    border: '1px solid var(--ui-line)',
                    borderRadius: 'var(--r-sm)',
                    outline: 'none',
                    fontSize: 12,
                    color: 'var(--text)',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                  }}
                />
                <div style={{ fontSize: 12, color: 'var(--overlay1)', marginTop: 2 }}>
                  {PROMPT_CATALOG[k].help}
                </div>
              </CollapsibleSection>
            );
          })}
        </section>
      ))}
      {groups.length === 0 && <p className="field-help">No prompts match “{filter}”.</p>}

      <div className="settings-prompt-footer">
        <button type="button" className="btn btn-secondary" onClick={resetAllCustomPrompts}>
          <RotateCcw size={12} /> Reset all
        </button>
      </div>
    </>
  );
}
