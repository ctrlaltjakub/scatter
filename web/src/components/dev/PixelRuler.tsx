'use client';
import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/store/useSettingsStore';

interface Props {
  /** Which placement this instance is responsible for. The component
   *  only renders when the store's pixelRulerMode matches this prop —
   *  so the same component class gets mounted twice in the tree (once
   *  at the viewport level, once inside the canvas-world) and the
   *  active one renders based on the user's choice. */
  attachment: 'viewport' | 'canvas';
}

/**
 * Dev-only pixel-measuring overlay. Draws a semi-transparent grid:
 *   - Faint cyan lines every 10 px
 *   - Solid cyan lines every 100 px with numeric labels (X labels along
 *     the top edge, Y labels along the left edge)
 *
 * VIEWPORT attachment uses position:fixed + 100vw/100vh — labels measure
 * browser-viewport pixels and don't react to canvas zoom.
 *
 * CANVAS attachment uses position:absolute inside the canvas-world
 * (which is itself transformed by translate + scale). Labels measure
 * untransformed canvas pixels, so a node that's 624 px wide always
 * spans 624 grid-pixels in this mode, regardless of zoom.
 */
export function PixelRuler({ attachment }: Props) {
  const mode = useSettingsStore((s) => s.pixelRulerMode);
  const active = mode === attachment;
  const [viewportDims, setViewportDims] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!active || attachment !== 'viewport') return;
    const update = () => setViewportDims({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [active, attachment]);

  if (!active) return null;

  // For viewport: extents are window dims.
  // For canvas: extents are large enough to cover any reasonable graph
  // (the canvas-world is logically infinite; the parent has overflow:
  // hidden so out-of-range parts are clipped).
  const w = attachment === 'viewport' ? viewportDims.w : 10000;
  const h = attachment === 'viewport' ? viewportDims.h : 10000;
  const originX = attachment === 'viewport' ? 0 : -5000;
  const originY = attachment === 'viewport' ? 0 : -5000;

  const xLabels: number[] = [];
  const yLabels: number[] = [];
  for (let x = 0; x <= w; x += 100) xLabels.push(x);
  for (let y = 0; y <= h; y += 100) yLabels.push(y);

  const minor = 'rgba(0, 200, 220, 0.08)';
  const major = 'rgba(0, 200, 220, 0.45)';

  const style: React.CSSProperties = attachment === 'viewport'
    ? {
      position: 'fixed',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 2147483646,
    }
    : {
      position: 'absolute',
      left: originX,
      top: originY,
      width: w,
      height: h,
      pointerEvents: 'none',
      zIndex: 2147483646,
    };

  return (
    <div
      data-sc-pixel-ruler={attachment}
      style={{
        ...style,
        backgroundImage: [
          `repeating-linear-gradient(0deg, transparent 0 9px, ${minor} 9px 10px)`,
          `repeating-linear-gradient(90deg, transparent 0 9px, ${minor} 9px 10px)`,
          `repeating-linear-gradient(0deg, transparent 0 99px, ${major} 99px 100px)`,
          `repeating-linear-gradient(90deg, transparent 0 99px, ${major} 99px 100px)`,
        ].join(', '),
      }}
    >
      {xLabels.map((x) => (
        <div
          key={`x${x}`}
          style={{
            position: 'absolute',
            left: x + 3,
            top: 3,
            fontSize: 11,
            lineHeight: 1,
            color: 'rgba(0, 200, 220, 1)',
            fontFamily: 'ui-monospace, "SF Mono", monospace',
            background: 'rgba(0, 0, 0, 0.65)',
            padding: '1px 3px',
            borderRadius: 2,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {attachment === 'canvas' ? x + originX : x}
        </div>
      ))}
      {yLabels.map((y) => (
        <div
          key={`y${y}`}
          style={{
            position: 'absolute',
            left: 3,
            top: y + 3,
            fontSize: 11,
            lineHeight: 1,
            color: 'rgba(0, 200, 220, 1)',
            fontFamily: 'ui-monospace, "SF Mono", monospace',
            background: 'rgba(0, 0, 0, 0.65)',
            padding: '1px 3px',
            borderRadius: 2,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {attachment === 'canvas' ? y + originY : y}
        </div>
      ))}
    </div>
  );
}
