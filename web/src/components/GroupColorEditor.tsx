'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Wheel, ShadeSlider, hsvaToHex, hexToHsva, type HsvaColor } from '@uiw/react-color';
import { Plus, X } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useGraphStore } from '@/store/useGraphStore';
import { DEFAULT_ACCENTS, colorToCss, isHexColor, resolveColorHex } from '@/lib/groupColor';
import { computeAnchoredPanelPos } from '@/lib/anchoredPanel';

/**
 * Color panel that opens under a group row while editing it. Shows, in order:
 *   1. the colours already assigned to groups (deduped), current one selected —
 *      so you can reuse an in-use colour and see what's taken;
 *   2. a divider + "catppuccin palette:" label (divider only if there were
 *      assigned colours above it);
 *   3. the 14 built-in Catppuccin accents + the user's custom colours, and an
 *      "add" affordance that opens a wheel preset to the group's CURRENT colour.
 *
 * Portaled to document.body (position:fixed) so the scrolling groups list
 * can't clip it; an rAF loop keeps it glued below its anchor row (and hides
 * it when the row scrolls out of the list's visible band). Stops click/
 * pointer propagation so interacting with it doesn't select the group (React
 * events still bubble through the REACT tree despite the portal); the row's
 * click-away rename-commit ignores the panel via isClickAwayFromRow.
 */
export function GroupColorEditor({ current, onPick, anchorRef }: {
  current: string;
  onPick: (color: string) => void;
  /** The group row the panel follows (the rename click-away boundary). */
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Follow the anchor row: fixed coords recomputed every frame while open —
  // tracks list scrolling, balanced-height re-caps, and sidebar transitions
  // with zero extra wiring (precedent: NodeSidePanel's transform loop).
  useLayoutEffect(() => {
    let raf = 0;
    const place = () => {
      const row = anchorRef.current;
      const el = panelRef.current;
      if (row && el) {
        const a = row.getBoundingClientRect();
        const clip = row.closest('.sidebar-section-body')?.getBoundingClientRect();
        const pos = computeAnchoredPanelPos({
          anchor: a,
          panelH: el.offsetHeight,
          viewportH: window.innerHeight,
          clip: clip ? { top: clip.top, bottom: clip.bottom } : undefined,
        });
        el.style.left = `${pos.left}px`;
        el.style.top = `${pos.top}px`;
        el.style.width = `${pos.width}px`;
        el.style.visibility = pos.visible ? 'visible' : 'hidden';
      }
      raf = requestAnimationFrame(place);
    };
    place(); // sync first frame — no flash at (0,0)
    return () => cancelAnimationFrame(raf);
  }, [anchorRef]);
  const customColors = useSettingsStore((s) => s.customColors);
  const addCustomColor = useSettingsStore((s) => s.addCustomColor);
  const removeCustomColor = useSettingsStore((s) => s.removeCustomColor);
  const groups = useGraphStore((s) => s.project?.groups);

  // Colours already in use across the project's groups, deduped, current first.
  const assigned: string[] = [];
  const seenAssigned = new Set<string>();
  for (const c of [current, ...(groups ? Object.values(groups).map((g) => g.color) : [])]) {
    const key = String(c).toLowerCase();
    if (!seenAssigned.has(key)) { seenAssigned.add(key); assigned.push(c); }
  }
  const isCurrent = (c: string) => String(c).toLowerCase() === String(current).toLowerCase();

  const [wheelOpen, setWheelOpen] = useState(false);
  const [hsva, setHsva] = useState<HsvaColor>(() => hexToHsva(resolveColorHex(current)));
  const hex = hsvaToHex(hsva);

  const openWheel = () => {
    setHsva(hexToHsva(resolveColorHex(current)));  // seed from the current color
    setWheelOpen(true);
  };

  return createPortal(
    <div
      ref={panelRef}
      className="group-color-editor"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {assigned.length > 0 && <div className="gc-section-label">project’s colors:</div>}
      {assigned.length > 0 && (
        <div className="group-color-swatches">
          {assigned.map((c) => (
            <button
              key={'assigned-' + c}
              type="button"
              className={'gc-swatch' + (isCurrent(c) ? ' sel' : '')}
              style={{ background: colorToCss(c) }}
              onClick={() => onPick(c)}
              data-tip={isCurrent(c) ? `Current color (${c})` : `Reuse ${c}`}
              aria-label={`Set color to ${c}`}
            />
          ))}
        </div>
      )}

      {assigned.length > 0 && <div className="gc-divider" />}
      <div className="gc-section-label">catppuccin palette:</div>

      <div className="group-color-swatches">
        {DEFAULT_ACCENTS.map((c) => (
          <button
            key={c}
            type="button"
            className={'gc-swatch' + (isCurrent(c) ? ' sel' : '')}
            style={{ background: colorToCss(c) }}
            onClick={() => onPick(c)}
            data-tip={`Set color to ${c}`}
            aria-label={`Set color to ${c}`}
          />
        ))}
        {customColors.map((c) => (
          <span key={c} className="gc-swatch-wrap">
            <button
              type="button"
              className={'gc-swatch' + (isCurrent(c) ? ' sel' : '')}
              style={{ background: c }}
              onClick={() => onPick(c)}
              data-tip={`Set color to ${c}`}
              aria-label={`Set color to ${c}`}
            />
            <button
              type="button"
              className="gc-swatch-del"
              onClick={() => removeCustomColor(c)}
              data-tip="Delete this custom color"
              aria-label="Delete custom color"
            >
              <X size={8} />
            </button>
          </span>
        ))}
        <button
          type="button"
          className="gc-swatch gc-swatch-add"
          onClick={() => (wheelOpen ? setWheelOpen(false) : openWheel())}
          data-tip="Add a custom color"
          aria-label="Add a custom color"
        >
          <Plus size={10} />
        </button>
      </div>

      {wheelOpen && (
        <div className="group-color-wheel">
          <Wheel
            color={hsva}
            onChange={(c) => setHsva({ ...hsva, ...c.hsva })}
            width={130}
            height={130}
          />
          <ShadeSlider
            hsva={hsva}
            onChange={(newShade) => setHsva({ ...hsva, ...newShade })}
            style={{ marginTop: 10, width: 130 }}
          />
          <div className="group-color-wheel-foot">
            <span className="gc-swatch" style={{ background: hex }} />
            <input
              className="gc-hex"
              value={hex}
              spellCheck={false}
              onChange={(e) => { if (isHexColor(e.target.value)) setHsva(hexToHsva(e.target.value)); }}
            />
            <button
              type="button"
              className="gc-add-btn"
              onClick={() => { addCustomColor(hex); onPick(hex); setWheelOpen(false); }}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
