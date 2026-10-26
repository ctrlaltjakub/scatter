'use client';
/**
 * The image editor's left panel — versions row (with the save-as-new-version
 * icon next to delete, like the text editor), crop controls that unfold only
 * in crop mode, annotation tools, the group-picker color palette (node accent
 * first, custom colors persisted via Settings), stroke width, fonts, and the
 * adjustment sliders. Reuses the text editor's panel classes (.versions-row /
 * .side-action / .te-divider) and the group color editor's swatch + wheel
 * classes, so it reads as the same family of UI.
 *
 * Undo/Redo share the version row because the app sidebar is temporarily
 * hidden; Ctrl/⌘+Z drives the same editor-local history.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Crop, Hand, Highlighter, Maximize2,
  MousePointer2, PenLine, RotateCcw, RotateCw, Save, SlidersHorizontal, Sparkles, Trash,
  Type, ZoomIn, ZoomOut,
} from 'lucide-react';
import { Wheel, ShadeSlider, hsvaToHex, hexToHsva, type HsvaColor } from '@uiw/react-color';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useGraphStore } from '@/store/useGraphStore';
import { DEFAULT_ACCENTS, isHexColor, resolveColorHex } from '@/lib/groupColor';
import {
  ANNOTATION_FONTS, APP_FONT_EX_HEIGHT_RATIO, APP_FONT_ID, fontFamilyFor, TEXT_SIZE_OPTIONS_PX, textSizeLabel,
} from '@/lib/imageEditFonts';
import type { Adjustments, CropState } from '@/lib/imageEditElements';
import type { EditorTool } from './ImageEditorCanvas';
import {
  IMAGE_EDITOR_ZOOM_STEP,
  MAX_IMAGE_EDITOR_ZOOM,
  MIN_IMAGE_EDITOR_ZOOM,
  imageEditorSliderToZoom,
  imageEditorZoomToSlider,
  type ImageEditorViewportController,
} from '@/lib/imageEditorViewport';
import { EditorHistoryButtons } from '@/components/editor/EditorHistoryButtons';
import { VersionCounter } from '@/components/VersionCounter';
import { FontDropdown } from '@/components/FontDropdown';

interface Props {
  verIdx: number;
  total: number;
  busy: boolean;
  ready: boolean;
  dirty: boolean;
  tool: EditorTool;
  crop: CropState;
  color: string;
  accentHex: string | null;
  strokeWidth: number;
  fontId: string;
  fontSize: number;
  adjustments: Adjustments;
  viewportController: ImageEditorViewportController;
  onSwitchVersion: (delta: -1 | 1) => void;
  onDeleteVersion: () => void;
  onSave: () => void;
  showGenerate: boolean;
  generateLabel: string;
  canGenerate: boolean;
  onGenerate: () => void;
  onTool: (t: EditorTool) => void;
  onRotate90: (dir: 1 | -1) => void;
  onFineAngle: (deg: number) => void;
  onClearCrop: () => void;
  onColor: (hex: string) => void;
  onStrokeWidth: (w: number) => void;
  onFont: (id: string) => void;
  onFontSize: (n: number) => void;
  onAdjust: (patch: Partial<Adjustments>) => void;
  onResetAdjust: () => void;
  onGestureEnd: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const TOOLS: { id: EditorTool; label: string; tip: string; Icon: typeof PenLine }[] = [
  { id: 'select', label: 'Select', tip: 'Drag to select image parts. Shift-drag selects over annotations; Ctrl/⌘-drag adds parts. Shift-click selects multiple annotations; Delete removes them. Esc clears image parts.', Icon: MousePointer2 },
  { id: 'hand', label: 'Hand', tip: 'Pan the image view. Space+drag temporarily pans with any tool; WASD also pans.', Icon: Hand },
  { id: 'pen', label: 'Pen', tip: 'Draw freehand', Icon: PenLine },
  { id: 'highlighter', label: 'Highlighter', tip: 'Highlight (translucent stroke)', Icon: Highlighter },
  { id: 'text', label: 'Text', tip: 'Click for a line of text; drag to draw a wrapping text box', Icon: Type },
  { id: 'arrow', label: 'Arrow', tip: 'Drag to draw an arrow', Icon: ArrowUpRight },
];

function SliderRow({ label, value, min, max, tip, disabled, onChange, onDone, suffix }: {
  label: string;
  value: number;
  min: number;
  max: number;
  tip: string;
  disabled: boolean;
  onChange: (v: number) => void;
  onDone: () => void;
  suffix?: string;
}) {
  // The numeric field edits a DRAFT string so it can sit temporarily empty
  // (or be just "-") while typing — a controlled number would snap back
  // instantly and eat deletions. Valid drafts commit live (clamped); blur or
  // Enter settles the field back onto the actual value.
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.round(Math.min(max, Math.max(min, n)));
  return (
    <div className="ie-slider-row">
      <div className="ie-slider-head">
        <span>{label}</span>
      </div>
      <div className="ie-slider-line">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          data-tip={tip}
          aria-label={label}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerUp={onDone}
          onKeyUp={onDone}
          onBlur={onDone}
        />
        <input
          className="ie-slider-num"
          type="text"
          inputMode="numeric"
          value={draft ?? String(value)}
          disabled={disabled}
          data-tip={tip}
          aria-label={`${label} value`}
          onChange={(e) => {
            const t = e.target.value;
            if (!/^-?\d*$/.test(t)) return;
            setDraft(t);
            if (t !== '' && t !== '-') onChange(clamp(Number(t)));
          }}
          onBlur={() => { setDraft(null); onDone(); }}
          onKeyDown={(e) => {
            // Typing must not trigger editor/app shortcuts (and Escape must
            // not close the editor) — same isolation as the canvas textarea.
            e.stopPropagation();
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        <span className="ie-slider-suffix">{suffix ?? ''}</span>
      </div>
    </div>
  );
}

export function ImageEditorPanel(p: Props) {
  const customColors = useSettingsStore((s) => s.customColors);
  const addCustomColor = useSettingsStore((s) => s.addCustomColor);
  const groups = useGraphStore((s) => s.project?.groups);
  const projectColor = useGraphStore((s) => s.project?.color);
  const [wheelOpen, setWheelOpen] = useState(false);
  const [hsva, setHsva] = useState<HsvaColor>(() => hexToHsva(p.color));
  const hex = hsvaToHex(hsva);
  const locked = !p.ready || p.busy;
  const view = useSyncExternalStore(
    p.viewportController.subscribe,
    p.viewportController.getSnapshot,
    p.viewportController.getSnapshot,
  );
  const zoomPercent = Math.round(view.zoom * 100);
  const fitted = view.zoom <= MIN_IMAGE_EDITOR_ZOOM
    && Math.abs(view.panX) < 0.01
    && Math.abs(view.panY) < 0.01;

  // Mirrors the group/project color picker's layout: first the colors already
  // in use across the project (node accent up front, as the recommended
  // pick), then the full palette. Everything resolved to concrete hex —
  // canvas text/strokes can't use the accents' CSS variables.
  const assigned = useMemo(() => {
    const list: { c: string; tip: string }[] = [];
    const seen = new Set<string>();
    const push = (hexColor: string, tip: string) => {
      const key = hexColor.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ c: hexColor, tip });
    };
    if (p.accentHex) push(p.accentHex, 'Node color (recommended)');
    if (projectColor) push(resolveColorHex(projectColor), 'Project color');
    for (const g of Object.values(groups ?? {})) {
      push(resolveColorHex(g.color), `Group “${g.name}” color`);
    }
    return list;
  }, [p.accentHex, projectColor, groups]);

  const palette = useMemo(() => {
    const list = DEFAULT_ACCENTS.map((name) => ({ c: resolveColorHex(name), tip: `Use ${name}` }));
    for (const c of customColors) {
      if (!list.some((s) => s.c.toLowerCase() === c.toLowerCase())) list.push({ c, tip: `Use ${c}` });
    }
    return list;
  }, [customColors]);

  const cropOn = p.tool === 'crop';
  const cropTouched = !!p.crop.rect || p.crop.fineAngle !== 0 || p.crop.quarterTurns !== 0;
  const adjTouched = !!(p.adjustments.saturation || p.adjustments.warmth || p.adjustments.contrast || p.adjustments.hue);

  return (
    <>
      <div className="ie-panel-main">
        <div className="versions-row">
          <div className="versions-row-cluster">
            <button type="button" disabled={p.verIdx === 0 || p.busy} onClick={() => p.onSwitchVersion(-1)} data-tip="Previous version" aria-label="Previous version">
              <ChevronLeft size={13} />
            </button>
            <VersionCounter current={p.verIdx + 1} total={p.total} />
            <button type="button" disabled={p.verIdx >= p.total - 1 || p.busy} onClick={() => p.onSwitchVersion(1)} data-tip="Next version" aria-label="Next version">
              <ChevronRight size={13} />
            </button>
          </div>
          <div className="versions-row-actions">
            <EditorHistoryButtons
              canUndo={p.canUndo && !p.busy}
              canRedo={p.canRedo && !p.busy}
              onUndo={p.onUndo}
              onRedo={p.onRedo}
              noun="image edit"
            />
            <button
              type="button"
              disabled={locked || !p.dirty}
              onClick={p.onSave}
              data-tip="Save the edits as a new version (the original stays one version back)"
              aria-label="Save as new version"
            >
              <Save size={13} />
            </button>
            <button type="button" disabled={p.total <= 1 || p.busy} onClick={p.onDeleteVersion} data-tip="Delete this version" aria-label="Delete version">
              <Trash size={13} />
            </button>
          </div>
        </div>

      {p.showGenerate && <button
        type="button"
        className="side-action side-action--tall"
        disabled={p.busy || !p.canGenerate}
        onClick={p.onGenerate}
        data-tip={p.canGenerate
          ? `${p.generateLabel} as a new image version`
          : 'Add prompt text and choose an image model in Settings if needed.'}
      >
        <span className="side-action-icon"><Sparkles size={15} /></span>
        {p.generateLabel}
      </button>}

      <button
        type="button"
        className={'side-action side-disclosure-trigger' + (cropOn ? ' toggled' : '')}
        aria-expanded={cropOn}
        aria-controls="image-editor-crop-tools"
        disabled={locked}
        onClick={() => p.onTool(cropOn ? 'select' : 'crop')}
        data-tip="Crop the image — drag the window and its handles"
      >
        <span className="side-action-icon"><Crop size={15} /></span>
        {cropOn ? 'Done cropping' : 'Crop'}
        <span className="side-disclosure-chevron">{cropOn ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
      </button>
      <div id="image-editor-crop-tools" className={'ie-croptools' + (cropOn ? ' open' : '')} aria-hidden={!cropOn}>
        <div className="ie-toolrow">
          <button type="button" className="ie-tool" disabled={locked || !cropOn} onClick={() => p.onRotate90(-1)} data-tip="Rotate 90° counter-clockwise" aria-label="Rotate counter-clockwise">
            <RotateCcw size={14} />
          </button>
          <button type="button" className="ie-tool" disabled={locked || !cropOn} onClick={() => p.onRotate90(1)} data-tip="Rotate 90° clockwise" aria-label="Rotate clockwise">
            <RotateCw size={14} />
          </button>
          <button
            type="button"
            className="ie-tool ie-tool--label"
            disabled={locked || !cropOn || !cropTouched}
            onClick={p.onClearCrop}
            data-tip="Remove the crop, rotation and straightening"
          >
            Reset
          </button>
        </div>
        <SliderRow
          label="Straighten"
          value={Math.round(p.crop.fineAngle)}
          min={-45}
          max={45}
          suffix="°"
          disabled={locked || !cropOn}
          tip="Fine rotation — the image auto-zooms so no corners go empty"
          onChange={(v) => p.onFineAngle(v)}
          onDone={p.onGestureEnd}
        />
      </div>

      <div className="te-divider" />

      <div className="ie-toolrow ie-toolrow--main">
        {TOOLS.map(({ id, label, tip, Icon }) => (
          <button
            key={id}
            type="button"
            className={'ie-tool' + (p.tool === id ? ' toggled' : '')}
            disabled={locked}
            onClick={() => p.onTool(id)}
            data-tip={tip}
            aria-label={label}
            aria-pressed={p.tool === id}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>

      <div className="ie-font-row">
        <FontDropdown
          grow
          value={p.fontId}
          valueLabel={ANNOTATION_FONTS.find((f) => f.id === p.fontId)?.label ?? p.fontId}
          valueStyle={{
            fontFamily: fontFamilyFor(p.fontId),
            fontSizeAdjust: p.fontId === APP_FONT_ID ? 'none' : String(APP_FONT_EX_HEIGHT_RATIO),
          }}
          options={ANNOTATION_FONTS.map((f) => ({
            id: f.id,
            label: f.label,
            sub: f.description,
            labelStyle: {
              fontFamily: fontFamilyFor(f.id),
              fontSizeAdjust: f.id === APP_FONT_ID ? 'none' : String(APP_FONT_EX_HEIGHT_RATIO),
            },
          }))}
          disabled={locked}
          tip="Font — applies to the text being edited or selected, and to new text"
          ariaLabel="Text font"
          onPick={p.onFont}
        />
        <FontDropdown
          value={String(p.fontSize)}
          valueLabel={textSizeLabel(p.fontSize)}
          options={TEXT_SIZE_OPTIONS_PX.map((px) => ({ id: String(px), label: textSizeLabel(px) }))}
          disabled={locked}
          tip="Text size — applies to the text being edited or selected, and to new text"
          ariaLabel="Text size"
          onPick={(id) => p.onFontSize(Number(id))}
        />
      </div>

      <div className="ie-swatches">
        {assigned.length > 0 && <div className="gc-section-label">project’s colors:</div>}
        {assigned.length > 0 && (
          <div className="group-color-swatches">
            {assigned.map(({ c, tip }) => (
              <button
                key={'assigned-' + c}
                type="button"
                className={'gc-swatch' + (p.color.toLowerCase() === c.toLowerCase() ? ' sel' : '')}
                style={{ background: c }}
                disabled={locked}
                onClick={() => p.onColor(c)}
                data-tip={tip}
                aria-label={tip}
              />
            ))}
          </div>
        )}
        {assigned.length > 0 && <div className="gc-divider" />}
        <div className="gc-section-label">catppuccin palette:</div>
        <div className="group-color-swatches">
          {palette.map(({ c, tip }) => (
            <button
              key={c}
              type="button"
              className={'gc-swatch' + (p.color.toLowerCase() === c.toLowerCase() ? ' sel' : '')}
              style={{ background: c }}
              disabled={locked}
              onClick={() => p.onColor(c)}
              data-tip={tip}
              aria-label={tip}
            />
          ))}
          <button
            type="button"
            className="gc-swatch gc-swatch-add"
            disabled={locked}
            onClick={() => {
              if (wheelOpen) { setWheelOpen(false); return; }
              setHsva(hexToHsva(p.color));
              setWheelOpen(true);
            }}
            data-tip="Add a custom color"
            aria-label="Add a custom color"
          >
            +
          </button>
        </div>
        {wheelOpen && (
          <div className="ie-wheel-pop">
            <div className="group-color-wheel">
              <Wheel
                color={hsva}
                onChange={(c) => { setHsva({ ...hsva, ...c.hsva }); p.onColor(hsvaToHex({ ...hsva, ...c.hsva })); }}
                width={130}
                height={130}
              />
              <ShadeSlider
                hsva={hsva}
                onChange={(s) => { const next = { ...hsva, ...s }; setHsva(next); p.onColor(hsvaToHex(next)); }}
                style={{ marginTop: 10, width: 130 }}
              />
              <div className="group-color-wheel-foot">
                <span className="gc-swatch" style={{ background: hex }} />
                <input
                  className="gc-hex"
                  value={hex}
                  spellCheck={false}
                  onChange={(e) => {
                    if (isHexColor(e.target.value)) {
                      setHsva(hexToHsva(e.target.value));
                      p.onColor(e.target.value);
                    }
                  }}
                />
                <button
                  type="button"
                  className="gc-add-btn"
                  onClick={() => { addCustomColor(hex); p.onColor(hex); setWheelOpen(false); }}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <SliderRow
        label="Stroke width"
        value={p.strokeWidth}
        min={1}
        max={400}
        suffix="px"
        disabled={locked}
        tip="Pen / highlighter / arrow thickness (in image pixels)"
        onChange={p.onStrokeWidth}
        onDone={p.onGestureEnd}
      />

      <div className="te-divider" />

      <div className="ie-section-label">
        <span className="side-action-icon"><SlidersHorizontal size={15} /></span>
        adjustments:
      </div>
      <SliderRow label="Saturation" value={p.adjustments.saturation} min={-100} max={100} disabled={locked} tip="Color intensity — −100 is grayscale" onChange={(v) => p.onAdjust({ saturation: v })} onDone={p.onGestureEnd} />
      <SliderRow label="Warmth" value={p.adjustments.warmth} min={-100} max={100} disabled={locked} tip="Color temperature — toward orange or toward blue" onChange={(v) => p.onAdjust({ warmth: v })} onDone={p.onGestureEnd} />
      <SliderRow label="Contrast" value={p.adjustments.contrast} min={-100} max={100} disabled={locked} tip="Distance from mid-gray" onChange={(v) => p.onAdjust({ contrast: v })} onDone={p.onGestureEnd} />
      <SliderRow label="Hue" value={p.adjustments.hue} min={-180} max={180} suffix="°" disabled={locked} tip="Rotate every color around the color wheel" onChange={(v) => p.onAdjust({ hue: v })} onDone={p.onGestureEnd} />
      <button
        type="button"
        className="side-action"
        disabled={locked || !adjTouched}
        onClick={p.onResetAdjust}
        data-tip="Set all four sliders back to zero"
      >
        <span className="side-action-icon"><RotateCcw size={15} /></span>
        Reset adjustments
      </button>
      </div>

      <div className="ie-navigation" role="group" aria-label="Image navigation">
        <button
          type="button"
          className="ie-nav-button"
          disabled={locked || view.zoom <= MIN_IMAGE_EDITOR_ZOOM}
          onClick={() => p.viewportController.animateZoomBy(1 / IMAGE_EDITOR_ZOOM_STEP)}
          data-tip="Zoom out (Q)"
          aria-label="Zoom out"
        >
          <ZoomOut size={16} />
        </button>
        <input
          type="range"
          className="ie-zoom-slider"
          min={0}
          max={100}
          step={0.1}
          value={imageEditorZoomToSlider(view.zoom)}
          disabled={locked}
          onChange={(e) => p.viewportController.setZoom(imageEditorSliderToZoom(Number(e.target.value)))}
          data-tip={`Image zoom — ${zoomPercent}%`}
          aria-label="Image zoom"
          aria-valuetext={`${zoomPercent}%`}
        />
        <button
          type="button"
          className="ie-nav-button"
          disabled={locked || view.zoom >= MAX_IMAGE_EDITOR_ZOOM}
          onClick={() => p.viewportController.animateZoomBy(IMAGE_EDITOR_ZOOM_STEP)}
          data-tip="Zoom in (E)"
          aria-label="Zoom in"
        >
          <ZoomIn size={16} />
        </button>
        <button
          type="button"
          className="ie-nav-button ie-nav-fit"
          disabled={locked || fitted}
          onClick={() => p.viewportController.fit()}
          data-tip="Fit and center the image"
        >
          <Maximize2 size={12} aria-hidden="true" /> Fit
        </button>
      </div>
    </>
  );
}
