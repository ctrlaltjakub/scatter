'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

type Item = { id: string; label: string };

/** Unlike a native select popup, this menu cannot grow past its field's width. */
export function SyncHistoryPicker({ value, onChange, active, deleted }: {
  value: string; onChange: (value: string) => void; active: Item[]; deleted: Item[];
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ up: false, height: 280 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = [...active, ...deleted];
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const field = trigger.current.getBoundingClientRect();
    const pane = root.current?.closest('.settings-pane')?.getBoundingClientRect();
    const below = Math.min(window.innerHeight, pane?.bottom ?? window.innerHeight) - field.bottom - 10;
    const above = field.top - Math.max(0, pane?.top ?? 0) - 10;
    const up = below < 240 && above > below;
    setPlacement({ up, height: Math.max(90, Math.min(280, up ? above : below)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    root.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);
  const option = (item: Item) => <button key={item.id} type="button" role="option"
    aria-selected={item.id === value} className="sync-history-option"
    onClick={() => { onChange(item.id); setOpen(false); trigger.current?.focus(); }}>
    <span>{item.label}</span>{item.id === value && <Check size={14} />}
  </button>;
  return <div ref={root} className="sync-history-picker" onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      const options = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    } else if (event.key === 'Tab') setOpen(false);
  }}>
    <button ref={trigger} id="sync-history-target" type="button" className="input sync-history-trigger"
      aria-label="History for" aria-haspopup="listbox" aria-expanded={open} aria-controls="sync-history-options"
      onClick={() => setOpen(!open)}>
      <span>{items.find(item => item.id === value)?.label ?? 'App settings'}</span><ChevronDown size={14} />
    </button>
    {open && <div id="sync-history-options" role="listbox" aria-label="History for" className={'sync-history-options' + (placement.up ? ' opens-up' : '')}
      style={{ maxHeight: placement.height }}>
      {active.map(option)}
      {deleted.length > 0 && <div role="separator" className="sync-history-divider" />}
      {deleted.map(option)}
    </div>}
  </div>;
}
