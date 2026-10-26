'use client';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search, X } from 'lucide-react';
import Fuse from 'fuse.js';
import { LANGUAGES, languageInfo } from '@/lib/languages';
import { useSettingsStore } from '@/store/useSettingsStore';
import { reasoningPopoverPosition } from '@/lib/reasoningPopover';
import { fallbackReadingFamily } from '@/lib/readingFonts';

const search = new Fuse([...LANGUAGES], { keys: ['name', 'native', 'code', 'locale'], threshold: 0.35, ignoreLocation: true });

export function LanguageControl({ placement = 'side', onOpen, onOpenChange }: {
  placement?: 'side' | 'below'; onOpen?: () => void; onOpenChange?: (open: boolean) => void;
}) {
  const language = useSettingsStore(state => state.generationLanguage);
  const choose = useSettingsStore(state => state.setGenerationLanguage);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<ReturnType<typeof reasoningPopoverPosition>>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = languageInfo(language);
  const matches = useMemo(() => query.trim() ? search.search(query.trim()).map(result => result.item) : LANGUAGES, [query]);
  useEffect(() => {
    if (!open) return;
    onOpenChange?.(true); input.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
    return () => { onOpenChange?.(false); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [open, onOpenChange]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const picker = trigger.current.closest('.sc-modelpicker') ?? trigger.current;
    const anchor = (placement === 'below' ? picker.closest('.canvas-topright') : picker.closest('.sidebar')) ?? picker;
    const update = () => {
      if (!panel.current) return;
      const next = reasoningPopoverPosition({ panel: anchor.getBoundingClientRect(), picker: picker.getBoundingClientRect(),
        below: placement === 'below', viewportWidth: innerWidth,
        viewportHeight: placement === 'side' ? Math.min(innerHeight, picker.getBoundingClientRect().bottom + 8) : innerHeight,
        height: panel.current.getBoundingClientRect().height, preferredWidth: 300 });
      setPosition(previous => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor); observer.observe(picker); observer.observe(panel.current);
    const stack = picker.closest('.sidebar-control-panel'); if (stack) observer.observe(stack);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, placement]);
  useLayoutEffect(() => {
    const viewport = list.current;
    if (!open || !viewport) return;
    // Filtering starts at the first result. Scroll fades are display-only and
    // update without rerendering the options or moving keyboard focus.
    viewport.scrollTop = 0;
    const update = () => {
      const extent = Math.min(24, viewport.clientHeight / 4);
      const remaining = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      viewport.style.setProperty('--language-fade-top', `${Math.min(extent, Math.max(0, viewport.scrollTop))}px`);
      viewport.style.setProperty('--language-fade-bottom', `${Math.min(extent, Math.max(0, remaining))}px`);
      // Keep the native scrollbar outside the text mask, including wider OS bars.
      viewport.style.setProperty('--language-scrollbar-width', `${Math.max(8, viewport.offsetWidth - viewport.clientWidth)}px`);
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    viewport.addEventListener('scroll', update, { passive: true });
    update();
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', update); };
  }, [open, matches]);
  return <>
    <button ref={trigger} type="button" className={`sc-modelpicker-websearch sc-language-trigger${open ? ' active' : ''}`}
      aria-label={`Generation language: ${selected.name}`} aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
      data-tip={`Generation language: ${selected.name}`}
      onClick={() => { if (!open) { setQuery(''); setPosition(undefined); onOpen?.(); } setOpen(value => !value); }}>
      <span className="sc-language-trigger-label">{selected.code}</span>
    </button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label="Generation language" className="sc-reasoning-pop sc-language-pop"
      style={{ ...position, visibility: position ? undefined : 'hidden' }}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        const options = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); const index = options.indexOf(document.activeElement as HTMLButtonElement);
          options[index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
        } else if (event.key === 'Enter' && event.target === input.current) options[0]?.click();
      }}>
      <div className="sc-language-heading"><strong>Generation language</strong><button className="icon-btn" aria-label="Close language picker"
        onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={14} /></button></div>
      <p className="field-help sc-language-hint">New content and regeneration use this language. Edits keep the source language.</p>
      <div className="search-wrap sc-language-search"><Search className="search-icon" size={13} />
        <input ref={input} type="search" className="search-input" aria-label="Search languages" placeholder="Search languages…"
          value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div ref={list} className="sc-language-list" role="listbox" aria-label="Languages">
        <div className="sc-language-options">
        {matches.map((item, index) => <button key={item.id} type="button" role="option" aria-selected={selected.id === item.id}
          tabIndex={selected.id === item.id || (index === 0 && !matches.some(match => match.id === selected.id)) ? 0 : -1}
          className={`sc-language-option${selected.id === item.id ? ' active' : ''}`}
          onClick={() => { choose(item.id); setOpen(false); trigger.current?.focus(); }}>
          <span className="sc-language-code">{item.code}</span><span><span>{item.name}</span><small lang={item.locale} style={{ fontFamily: fallbackReadingFamily(item.id) }}>{item.native}</small></span>
          {selected.id === item.id && <Check size={14} aria-hidden="true" />}
        </button>)}
        {!matches.length && <p className="field-help">No matching languages.</p>}
        </div>
      </div>
    </div>, trigger.current?.closest('.welcome--picker') ?? document.body)}
  </>;
}
