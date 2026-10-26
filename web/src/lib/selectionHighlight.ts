const PRESERVED_SELECTION = 'sc-preserved-selection';

type HighlightCtor = new (...ranges: Range[]) => unknown;
interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function highlightApi(): { Ctor: HighlightCtor; registry: HighlightRegistry } | null {
  const Ctor = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  return Ctor && registry ? { Ctor, registry } : null;
}

/**
 * Paint a clone of the browser selection while focus moves into the follow-up
 * panel. The CSS Highlight API is visual only, so the textarea keeps its own
 * caret and keyboard behavior.
 */
export function preserveSelectionHighlight(range: Range): boolean {
  const api = highlightApi();
  if (!api) return false;
  const origin = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element
    : range.commonAncestorContainer.parentElement;
  const node = origin?.closest<HTMLElement>('.node');
  const accent = node ? getComputedStyle(node).getPropertyValue('--sel-bg').trim() : '';
  if (accent) document.documentElement.style.setProperty('--sc-preserved-selection-bg', accent);
  api.registry.set(PRESERVED_SELECTION, new api.Ctor(range.cloneRange()));
  return true;
}

export function clearPreservedSelectionHighlight(): void {
  highlightApi()?.registry.delete(PRESERVED_SELECTION);
  document.documentElement.style.removeProperty('--sc-preserved-selection-bg');
}
