import type { Rect } from './sceneState';

export const CHAT_RAY_PERCENTAGES = [50, 33, 10] as const;
export const CHAT_RAY_MAX_ROW = CHAT_RAY_PERCENTAGES.length;

/** Reference geometry for the shader's concentric rows. Use the nearest cell
 * centers outside the card, including partially covered cells, so no ordinary
 * dense-glyph row slips between the card and its rays. Zero means inside. */
export function chatRayRow(col: number, row: number, rect: Rect, cell: number): number {
  const left = Math.ceil(rect.x / cell - 0.5);
  const top = Math.ceil(rect.y / cell - 0.5);
  const right = Math.floor((rect.x + rect.w) / cell - 0.5);
  const bottom = Math.floor((rect.y + rect.h) / cell - 0.5);
  return Math.max(0, left - col, col - right, top - row, row - bottom);
}

/** The first row keeps its existing precedence over overlapping auras. */
export function isChatRayCell(col: number, row: number, rect: Rect, cell: number): boolean {
  return chatRayRow(col, row, rect, cell) === 1;
}

/** A stable, node-seeded sample in the first three rows. No clock/focus input, so the
 * pattern does not shimmer as the aura animates. Mirrors the GPU hash below. */
export function shouldUseChatRay(col: number, row: number, glyphSeed: number, rayRow: number): boolean {
  if (rayRow < 1 || rayRow > CHAT_RAY_MAX_ROW) return false;
  let h = (Math.imul(col, 374761393) + Math.imul(row, 668265263)) >>> 0;
  h = Math.imul((h ^ (h >>> 13)) >>> 0, 1274126177) >>> 0;
  h = (h ^ (h >>> 16) ^ Math.imul(glyphSeed & 0xffff, -2048144789) ^ 0xa24baed5) >>> 0;
  h = Math.imul((h ^ (h >>> 15)) >>> 0, -1028477387) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h % 100 < CHAT_RAY_PERCENTAGES[rayRow - 1]!;
}

/** Quantized outward direction, not a tangential box outline. Normalizing by
 * half-size gives tall chats and short chats the same fan-shaped corners. */
export function chatRayGlyph(x: number, y: number, rect: Rect): '_' | '|' | '/' | '\\' {
  const dx = (x - rect.x - rect.w / 2) / Math.max(1, rect.w / 2);
  const dy = (y - rect.y - rect.h / 2) / Math.max(1, rect.h / 2);
  return Math.abs(dx) > 2 * Math.abs(dy) ? '_'
    : Math.abs(dy) > 2 * Math.abs(dx) ? '|'
      : dx * dy > 0 ? '\\' : '/';
}

/** Shared GPU geometry; the functions above are the unit-test reference. */
export const CHAT_RAY_GLSL = `
const uint CHAT_RAY_PERCENTAGES[${CHAT_RAY_MAX_ROW}] = uint[${CHAT_RAY_MAX_ROW}](${CHAT_RAY_PERCENTAGES.map(value => `${value}u`).join(', ')});

int chatRayRow(vec2 cell, vec4 screenRect, float pitch) {
  vec2 lo = ceil(screenRect.xy / pitch - vec2(0.5));
  vec2 hi = floor((screenRect.xy + screenRect.zw) / pitch - vec2(0.5));
  vec2 outside = max(lo - cell, cell - hi);
  return int(max(0.0, max(outside.x, outside.y)));
}

bool isChatRayCell(vec2 cell, vec4 screenRect, float pitch) {
  return chatRayRow(cell, screenRect, pitch) == 1;
}

bool shouldUseChatRay(uint h, uint glyphSeed, int rayRow) {
  if (rayRow < 1 || rayRow > ${CHAT_RAY_MAX_ROW}) return false;
  h = h ^ (glyphSeed * 2246822507u) ^ 2722868949u;
  h = (h ^ (h >> 15u)) * 3266489909u;
  h = h ^ (h >> 16u);
  return h % 100u < CHAT_RAY_PERCENTAGES[rayRow - 1];
}
`;
