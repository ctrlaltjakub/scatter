import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

// Lucide icon geometry (paths copied from lucide-react@1.14.0). Rendered as an
// outline (the Lucide look) with a white halo under-stroke for visibility, dark
// over-stroke on top. Each cursor is a list of LAYERS so a composite can mix
// stroke weights (e.g. a thick arrow + a thinner I-beam).
const P = (d) => `<path d='${d}'/>`;
const join = (...ds) => ds.map(P).join('');

const MOUSE_POINTER_2 = P(
  "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z",
);
const MOUSE_POINTER_CLICK = join(
  "M14 4.1 12 6", "m5.1 8-2.9-.8", "m6 12-1.9 2", "M7.2 2.2 8 5.1",
  "M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z",
);
const MOUSE_POINTER_2_OFF = join(
  "m15.55 8.45 5.138 2.087a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063L8.45 15.551",
  "M22 2 2 22",
  "m6.816 11.528-2.779-6.84a.495.495 0 0 1 .651-.651l6.84 2.779",
);
const TEXT_CURSOR = join(
  "M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1",
  "M7 22h1a4 4 0 0 0 4-4v-1",
  "M7 2h1a4 4 0 0 1 4 4v1",
);
const MOVE = join(
  "M12 2v20", "m15 19-3 3-3-3", "m19 9 3 3-3 3", "M2 12h20", "m5 9-3 3 3 3", "m9 5 3-3 3 3",
);
const HAND = join(
  "M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2",
  "M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2",
  "M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8",
  "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
);
const HAND_GRAB = join(
  "M18 11.5V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4",
  "M14 10V8a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2",
  "M10 9.9V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v5",
  "M6 14a2 2 0 0 0-2-2a2 2 0 0 0-2 2",
  "M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8 2 2 0 1 1 4 0",
);
const EXPAND = join(
  "m15 15 6 6", "m15 9 6-6", "M21 16v5h-5", "M21 8V3h-5", "M3 16v5h5", "m3 21 6-6", "M3 8V3h5", "M9 9 3 3",
);
// Resize cursors: double-headed Lucide move arrows. One diagonal glyph serves
// both ends of its diagonal (TL+BR = move-diagonal-2, TR+BL = move-diagonal);
// edges get move-vertical / move-horizontal; rotation gets refresh-ccw.
const MOVE_DIAGONAL = join("M11 19H5v-6", "M13 5h6v6", "M19 5 5 19");
const MOVE_DIAGONAL_2 = join("M19 13v6h-6", "M5 11V5h6", "m5 5 14 14");
const MOVE_VERTICAL = join("M12 2v20", "m8 18 4 4 4-4", "m8 6 4-4 4 4");
const MOVE_HORIZONTAL = join("m18 8 4 4-4 4", "M2 12h20", "m6 8-4 4 4 4");
const REFRESH_CCW = join(
  "M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
  "M3 3v5h5",
  "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16",
  "M16 16h5v5",
);

// Composite "term" cursor: a THICK MousePointer2 (left) + a SAME-PIXEL-HEIGHT
// I-beam to its right. The arrow's bbox is ~16.6 units tall (y 4.04→20.69); the
// TextCursor is 20 tall (y 2→22), so scale it 0.83 and nudge it down so both
// centers align, then shift it right of the arrow.
const TERM_IBEAM = `<g transform='translate(17.2 2.4) scale(0.83)'>${TEXT_CURSOR}</g>`;

// Each cursor = { layers: [{ d, stroke }], hotspot:[x,y], fallback, viewW }.
// stroke 2 = normal Lucide weight, 3 = "thick". hand & grab share a hotspot so
// the cursor doesn't jump when a pan starts.
export const CURSORS = {
  pointer: { layers: [{ d: MOUSE_POINTER_2, stroke: 2 }], hotspot: [4, 4], fallback: 'default', viewW: 24 },
  // Hover-clickable = the SAME normal mouse-pointer-2 (the thick variant read
  // badly). The "clickable" signal is the press flash (--cur-press), not a hover
  // weight change.
  click:   { layers: [{ d: MOUSE_POINTER_2, stroke: 2 }], hotspot: [4, 4], fallback: 'pointer', viewW: 24 },
  // Brief press feedback only (the click-flash). The mouse-pointer-click glyph.
  press:   { layers: [{ d: MOUSE_POINTER_CLICK, stroke: 2 }], hotspot: [9, 9], fallback: 'pointer', viewW: 24 },
  // "Not available" = mouse-pointer-2-off.
  ban:     { layers: [{ d: MOUSE_POINTER_2_OFF, stroke: 2 }], hotspot: [4, 4], fallback: 'not-allowed', viewW: 24 },
  move:    { layers: [{ d: MOVE, stroke: 2 }], hotspot: [12, 12], fallback: 'move', viewW: 24 },
  hand:    { layers: [{ d: HAND, stroke: 2 }], hotspot: [12, 12], fallback: 'grab', viewW: 24 },
  grab:    { layers: [{ d: HAND_GRAB, stroke: 2 }], hotspot: [12, 12], fallback: 'grabbing', viewW: 24 },
  expand:  { layers: [{ d: EXPAND, stroke: 2 }], hotspot: [12, 12], fallback: 'nwse-resize', viewW: 24 },
  // Resize handles (nodes + image-editor elements/crop): double-headed move
  // arrows along the grabbed axis — one diagonal glyph per diagonal, mirrored
  // pairing (TL+BR / TR+BL), plus edge and rotate cursors.
  'scaling-tl': { layers: [{ d: MOVE_DIAGONAL_2, stroke: 2 }], hotspot: [12, 12], fallback: 'nwse-resize', viewW: 24 },
  'scaling-br': { layers: [{ d: MOVE_DIAGONAL_2, stroke: 2 }], hotspot: [12, 12], fallback: 'nwse-resize', viewW: 24 },
  'scaling-tr': { layers: [{ d: MOVE_DIAGONAL, stroke: 2 }], hotspot: [12, 12], fallback: 'nesw-resize', viewW: 24 },
  'scaling-bl': { layers: [{ d: MOVE_DIAGONAL, stroke: 2 }], hotspot: [12, 12], fallback: 'nesw-resize', viewW: 24 },
  'resize-v':   { layers: [{ d: MOVE_VERTICAL, stroke: 2 }], hotspot: [12, 12], fallback: 'ns-resize', viewW: 24 },
  'resize-h':   { layers: [{ d: MOVE_HORIZONTAL, stroke: 2 }], hotspot: [12, 12], fallback: 'ew-resize', viewW: 24 },
  rotate:       { layers: [{ d: REFRESH_CCW, stroke: 2 }], hotspot: [12, 12], fallback: 'crosshair', viewW: 24 },
  text:    { layers: [{ d: TEXT_CURSOR, stroke: 2 }], hotspot: [12, 12], fallback: 'text', viewW: 24 },
  // Terms are clickable AND selectable: normal arrow + matched-height I-beam.
  term:    { layers: [{ d: MOUSE_POINTER_2, stroke: 2 }, { d: TERM_IBEAM, stroke: 2.4 }], hotspot: [4, 4], fallback: 'pointer', viewW: 34 },
};

// Every cursor is rendered 20% smaller than the 24px Lucide art (per user
// request). One global factor keeps hotspots + pixel sizes in lockstep.
const SCALE = 0.8;
const r = (n) => Math.round(n * SCALE);

export const CURSOR_DENSITIES = [1, 2, 3, 4];
const SUPERSAMPLE = 4;

export function cursorSvg(layers, viewW, density = 1) {
  const grp = (color, plus) =>
    layers.map((l) => `<g stroke='${color}' stroke-width='${l.stroke + plus}'>${l.d}</g>`).join('');
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${r(viewW) * density}' height='${r(24) * density}' ` +
    `viewBox='0 0 ${viewW} 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>` +
    `${grp('#ffffff', 2)}${grp('#1a1a1a', 0)}` +
    `</svg>`
  );
}

/** Build-time only: control edge coverage before handing a cursor to the OS.
 * Drawing large and reducing in premultiplied alpha keeps thin diagonals and
 * the white halo antialiased even on low-DPI Windows displays. No runtime
 * cursor drawing or pointer-following DOM element is needed. */
export async function cursorPng(cursor, density) {
  return sharp(Buffer.from(cursorSvg(cursor.layers, cursor.viewW, density * SUPERSAMPLE)))
    .resize(r(cursor.viewW) * density, r(24) * density, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function generateCursorCss() {
  let css =
    `/* Custom Lucide-geometry cursors. AUTO-GENERATED by scripts/gen-cursors.mjs\n` +
    `   (run: node scripts/gen-cursors.mjs src/app/cursors.css) — edit the\n` +
    `   generator, not this file. Outline icon (Lucide look) with a white halo\n` +
    `   under-stroke for visibility; dark over-stroke on top. Rendered at ${SCALE}×\n` +
    `   the 24px art. Model: --cur-pointer / --cur-click = normal arrow (general +\n` +
    `   hover-clickable look the same); --cur-press = click glyph (brief press\n` +
    `   flash, the real clickable signal); --cur-ban = pointer-off; --cur-term =\n` +
    `   normal arrow + matched I-beam.\n` +
    `   Pre-antialiased PNGs at 1x–4x retain the same logical sizes/hotspots.\n` +
    `   SVG cursors remain the fallback when cursor image-set is unsupported. */\n` +
    `:root {\n`;
  for (const [name, c] of Object.entries(CURSORS)) {
    const uri = `data:image/svg+xml,${encodeURIComponent(cursorSvg(c.layers, c.viewW))}`;
    css += `  --cur-${name}: url("${uri}") ${r(c.hotspot[0])} ${r(c.hotspot[1])}, ${c.fallback};\n`;
  }
  css += `}\n\n@supports (cursor: image-set(url("") 1x) 0 0, auto) {\n  :root {\n`;
  for (const [name, c] of Object.entries(CURSORS)) {
    const images = await Promise.all(CURSOR_DENSITIES.map(async density => {
      const png = await cursorPng(c, density);
      return `url("data:image/png;base64,${png.toString('base64')}") ${density}x`;
    }));
    css += `    --cur-${name}: image-set(${images.join(', ')}) ${r(c.hotspot[0])} ${r(c.hotspot[1])}, ${c.fallback};\n`;
  }
  return css + `  }\n}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/gen-cursors.mjs src/app/cursors.css');
  const css = await generateCursorCss();
  writeFileSync(process.argv[2], css);
  console.log('wrote', process.argv[2], css.length, 'bytes');
}
