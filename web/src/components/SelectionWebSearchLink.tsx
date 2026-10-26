'use client';

import { selectedSearchEngine, selectionSearchUrl } from '@/lib/selectionWebSearch';
import { useSettingsStore } from '@/store/useSettingsStore';

/** A native link keeps new-tab navigation in the user's click, without an AI
 * request, popup workarounds, or a canvas undo entry. */
export function SelectionWebSearchLink({ text }: { text: string }) {
  const settings = useSettingsStore(state => state.selectionWebSearch);
  const engine = selectedSearchEngine(settings);
  const href = selectionSearchUrl(text, engine.urlTemplate);
  if (!href) return null;
  return (
    <a className="sc-sel-btn sc-sel-search-btn" href={href} target="_blank" rel="noopener noreferrer"
      data-tip={`Search with ${engine.name} in a new tab`} onClick={event => event.stopPropagation()}>
      Web search
    </a>
  );
}
