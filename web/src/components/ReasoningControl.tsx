'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ActiveModelRef, ReasoningEffort } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useGraphStore } from '@/store/useGraphStore';
import { modelCatalogRequestKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { getAdapter, resolveBaseUrl } from '@/providers/registry';
import { colorToCss } from '@/lib/groupColor';
import { effectiveReasoningEffort, reasoningLevels, REASONING_LABELS } from '@/lib/modelReasoning';
import { reasoningPopoverPosition } from '@/lib/reasoningPopover';
import { ReasoningGauge } from './ReasoningGauge';

export function ReasoningControl({ modelRef, value, onChange, onOpen, onOpenChange, inline = false, placement = 'side' }: {
  modelRef: ActiveModelRef | null | undefined;
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  onOpen?: () => void;
  onOpenChange?: (open: boolean) => void;
  inline?: boolean;
  placement?: 'side' | 'below';
}) {
  const provider = useSettingsStore((s) => s.providers.find((p) => p.id === modelRef?.providerId));
  const info = useModelCatalogStore((s) => modelRef ? s.catalog[modelRef.providerId]?.find((m) => m.id === modelRef.model) : undefined);
  const color = useGraphStore((s) => s.project?.color);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const id = useId();
  const [position, setPosition] = useState<ReturnType<typeof reasoningPopoverPosition> | null>(null);
  const connectionKey = provider ? modelCatalogRequestKey(provider) : '';

  useEffect(() => {
    if (!provider?.apiKey.trim() || !modelRef) return;
    void useModelCatalogStore.getState().refreshCatalog(provider.id, connectionKey, () =>
      getAdapter(provider.preset).listModels(provider.apiKey, resolveBaseUrl(provider.preset, provider.baseUrl)),
    ).catch(() => {});
  }, [provider?.id, connectionKey, modelRef?.model]);
  useEffect(() => {
    if (!open) return;
    onOpenChange?.(true);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);
  useLayoutEffect(() => {
    if (!open || inline || !root.current || !popup.current) return;
    const picker = root.current.closest('.sc-modelpicker') ?? root.current;
    const panel = (placement === 'below' ? picker.closest('.canvas-topright') : picker.closest('.sidebar')) ?? picker;
    const update = () => {
      if (!popup.current) return;
      const next = reasoningPopoverPosition({
        panel: panel.getBoundingClientRect(), picker: picker.getBoundingClientRect(),
        below: placement === 'below', viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        height: popup.current.getBoundingClientRect().height,
      });
      setPosition((current) => current?.left === next.left && current.top === next.top && current.width === next.width && current.maxWidth === next.maxWidth ? current : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    observer.observe(picker);
    observer.observe(popup.current);
    // Sources can resize the control stack above/below the model row.
    const stack = picker.closest('.sidebar-control-panel');
    if (stack) observer.observe(stack);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, inline, placement]);
  useEffect(() => {
    if (!open) return;
    slider.current?.focus();
    const down = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true); };
  }, [open]);
  useEffect(() => setOpen(false), [modelRef?.providerId, modelRef?.model]);

  const levels = provider && modelRef ? reasoningLevels(provider.preset, modelRef.model, info) : [];
  const effective = provider && modelRef ? effectiveReasoningEffort(provider.preset, modelRef.model, value, info) : undefined;
  const selectedIndex = effective ? Math.max(0, levels.indexOf(effective)) : 0;
  const progress = levels.length > 1 ? selectedIndex / (levels.length - 1) * 100 : 0;
  const unavailable = !levels.length;
  const levelLabel = (level: ReasoningEffort) => info?.reasoning?.mode === 'toggle' && level !== 'off' ? 'On' : REASONING_LABELS[level];
  const label = effective ? levelLabel(effective) : 'Unavailable';
  const accentStyle = { '--reasoning-accent': color ? colorToCss(color) : 'var(--mauve)' } as CSSProperties;
  const body = (
    <div className="sc-reasoning-panel" id={id}>
      <div className="sc-reasoning-heading">
        <span>Reasoning level:</span><strong className="sc-reasoning-value">
          <span>{label}</span>
          {!inline && placement === 'side' && levels.map((level) => (
            <span key={level} aria-hidden="true" className="sc-reasoning-size-label">{levelLabel(level)}</span>
          ))}
        </strong>
      </div>
      {unavailable ? <p className="field-help">This model does not expose adjustable reasoning.</p> : (
        <div className="sc-reasoning-track" style={{ '--reasoning-progress': `${progress}%` } as CSSProperties}>
          <div className="sc-reasoning-stops" aria-hidden="true">
            {levels.map((level, index) => <span key={level} title={levelLabel(level)}
              style={{ left: `${levels.length > 1 ? index / (levels.length - 1) * 100 : 0}%`, visibility: index === selectedIndex ? 'hidden' : undefined }} />)}
          </div>
          <input ref={slider} type="range" min={0} max={Math.max(1, levels.length - 1)} step={1}
            value={selectedIndex} disabled={levels.length < 2} aria-label="Reasoning effort" aria-valuetext={label}
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => { const level = levels[Number(event.target.value)]; if (level) onChange(level); }} />
        </div>
      )}
    </div>
  );
  return (
    <div ref={root} className={`sc-reasoning-control${inline ? ' is-inline' : ''}`}
      style={accentStyle}>
      {inline ? body : <>
        <button ref={trigger} type="button" className={`sc-modelpicker-websearch sc-reasoning-trigger${open ? ' active' : ''}`}
          aria-label="Reasoning effort" aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
          disabled={unavailable} data-tip={unavailable ? 'This model does not expose adjustable reasoning.' : `Reasoning effort: ${label}`}
          onClick={() => { if (!open) onOpen?.(); setOpen((value) => !value); }}><ReasoningGauge effort={effective} /></button>
        {open && createPortal(<div ref={popup} role="dialog" aria-label="Main model reasoning" className="sc-reasoning-pop"
          onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}
          style={{ ...accentStyle, ...position, visibility: position ? undefined : 'hidden' }}>{body}</div>,
          // Keep the flyout in the topic picker's stacking layer. A body portal
          // uses the canvas z-index and otherwise opens behind its backdrop.
          root.current?.closest('.welcome--picker') ?? document.body)}
      </>}
    </div>
  );
}
