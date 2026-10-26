/**
 * R5 — GLSL ES 3.00 shaders for the WebGL aura renderer.
 *
 * Two passes per frame:
 *
 *   Pass A (cell state) — renders one fragment per GRID CELL into a
 *   ping-pong RGBA8 texture. Replicates what was the CPU hot loop: per cell,
 *   loop the aura/ghost records (data texture), rect-SDF distance →
 *   steady density + wave bonus → weighted seeded arbitration →
 *   target stage → time-based cooling vs the previous frame's texel.
 *   Output texel: R = integer stage byte, G = stage fraction byte,
 *   B = winner record index (255 = none), A = winner alpha.
 *
 *   Pass B (composite) — one fragment per DEVICE PIXEL onto the
 *   canvas. Maps the pixel to its cell, reads the cell-state texel,
 *   picks the glyph (hash % pool — bit-identical to the TS pick),
 *   samples the glyph atlas and multiplies by the winner color (or
 *   the baseline palette / neutral). Premultiplied-alpha output,
 *   no blending needed.
 *
 * All scene constants are interpolated from the canonical TS modules
 * so the shader can never drift from the unit-tested spec.
 *
 * Coordinate convention: cell (col, row) counts row 0 at the TOP
 * (screen-natural, top-down). Pass A's framebuffer texel (x, y) IS
 * cell (col=x, row=y) — no flip; the single bottom-up→top-down flip
 * happens in pass B when mapping gl_FragCoord to a cell.
 */
import {
  WAVE_DURATION_MS,
  WAVE_SPEED_PX_PER_S,
  UNFOCUS_DURATION_MS,
  UNFOCUS_START_RADIUS_PX,
  RIPPLE_WAVELENGTH_PX,
  RIPPLE_SIGMA_PX,
  AMP_DECAY_LEN_PX,
  COLLAPSE_DURATION_MS,
} from '../wave';
import { RAMP, STAGE_OFFSETS, STAGE_LENGTHS } from '../ramp';
import { statusGlyphIndex } from '../statusText';
import {
  GROUP_COLOR_RECORD_HIGH_BYTE,
  GROUP_COLOR_RECORD_LOW_BYTE,
  PROJECT_COLOR_INHERIT_OPACITY_BYTE,
} from './overlay';
import { FOCUS_BOOST } from '../sceneState';
import { CHAT_RAY_GLSL } from '../chatRays';
import {
  MAX_RECORDS,
  KIND_GHOST,
  KIND_EXPLAIN_AURA,
  KIND_CHAT_AURA,
  EXPLAIN_QUESTION_MIN_STAGE,
  EXPLAIN_QUESTION_MAX_STAGE,
  EXPLAIN_QUESTION_SAMPLE_EVERY,
  WAVE_RIPPLE,
  WAVE_COLLAPSE,
  WAVE_RECEDE,
} from './recordPacking';
import { MAX_PALETTE } from './paletteGL';
import { boldRayGlyphIndex } from './atlasLayout';

/** Winner-index byte value meaning "no winning record". */
export const WINNER_NONE = 255;

/** Max distinct status-text colours per frame (one per simultaneously-
 *  generating node's group accent). Indexed by the overlay's B channel. */
export const MAX_STATUS_COLORS = 8;

/** Opacity floor for generation/status text. Shape-only labels set overlay A
 *  and inherit the field cell's alpha without this floor. */
export const OVERLAY_MIN_ALPHA = 0.8;

/** Absolute alpha lift for question marks in unfocused explain auras. */
export const EXPLAIN_QUESTION_UNFOCUSED_ALPHA_BOOST = 0.1;

const STAGES = RAMP.length;
const QUESTION_GLYPH_INDEX = statusGlyphIndex('?')!;

const fmt = (n: number): string => Number.isInteger(n) ? `${n}.0` : `${n}`;

/** Fullscreen triangle, no vertex buffers (gl_VertexID trick). */
export const VERTEX_SRC = `#version 300 es
void main() {
  vec2 pos = vec2(
    gl_VertexID == 1 ? 3.0 : -1.0,
    gl_VertexID == 2 ? 3.0 : -1.0
  );
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

/** Per-cell imul/xorshift hash (grid coords → pseudo-random uint), used to vary
 *  the baseline glyph/colour per cell. This GLSL version is now the canonical one.
 *  Valid for the non-negative cell coordinates of the screen grid. */
const HASH_GLSL = `
uint cellHash(int cx, int cy) {
  uint h = uint(cx) * 374761393u;
  h = h + uint(cy) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return h;
}
`;

export const PASS_A_FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uRecords;     // RGBA32F, 4 texels per record
uniform sampler2D uPrevState;   // previous frame's cell state (RGBA8)
uniform int uRecordCount;
uniform vec3 uViewport;         // x, y in CSS px; z = zoom
uniform float uCellCssPx;       // cell pitch in CSS px (deviceCellPx / dpr)
uniform float uDtMs;            // ms since the previous pass-A frame
uniform float uCoolRate;        // displayed ramp stages cooled per second
uniform int uResetHistory;      // 1 → ignore uPrevState (resize/zoom/restore)

out vec4 outState;

const int MAX_RECORDS = ${MAX_RECORDS};
const float FOCUS_BOOST = ${fmt(FOCUS_BOOST)};
const float WAVE_MS = ${fmt(WAVE_DURATION_MS)};
const float WAVE_SPEED = ${fmt(WAVE_SPEED_PX_PER_S)};
const float UNFOCUS_MS = ${fmt(UNFOCUS_DURATION_MS)};
const float UNFOCUS_R0 = ${fmt(UNFOCUS_START_RADIUS_PX)};
const float RIPPLE_LAMBDA = ${fmt(RIPPLE_WAVELENGTH_PX)};
const float RIPPLE_SIGMA = ${fmt(RIPPLE_SIGMA_PX)};
const float AMP_DECAY_LEN = ${fmt(AMP_DECAY_LEN_PX)};
const float TWO_PI = 6.28318530718;
const float COLLAPSE_MS = ${fmt(COLLAPSE_DURATION_MS)};
const int STAGES = ${STAGES};
const float KIND_GHOST = ${fmt(KIND_GHOST)};
const float WAVE_RIPPLE_K = ${fmt(WAVE_RIPPLE)};
const float WAVE_COLLAPSE_K = ${fmt(WAVE_COLLAPSE)};
const float WAVE_RECEDE_K = ${fmt(WAVE_RECEDE)};

${HASH_GLSL}
${CHAT_RAY_GLSL}

bool isChatRayAtCell(vec4 rect) {
  vec4 screenRect = vec4(rect.xy * uViewport.z + uViewport.xy, rect.zw * uViewport.z);
  return isChatRayCell(floor(gl_FragCoord.xy), screenRect, uCellCssPx);
}

// distanceToRectBorder (geometry.ts): 0 inside, else distance to the
// nearest border point.
float distToRectBorder(vec2 p, vec4 rect) {
  float dx = max(max(rect.x - p.x, 0.0), p.x - (rect.x + rect.z));
  float dy = max(max(rect.y - p.y, 0.0), p.y - (rect.y + rect.w));
  return length(vec2(dx, dy));
}

// Gabor wavelet (mirror of wave.ts wavelet()): cosine carrier x
// Gaussian envelope.
float wavelet(float delta) {
  float carrier = cos(TWO_PI * delta / RIPPLE_LAMBDA);
  float env = exp(-(delta * delta) / (2.0 * RIPPLE_SIGMA * RIPPLE_SIGMA));
  return carrier * env;
}

// One expanding/receding ripple sampled for a single start time
// (mirror of wave.ts waveDensity's ripple branch). elapsedMs < 0 marks
// an empty slot (no contribution).
float singleRipple(float dist, bool receding, float elapsedMs) {
  if (elapsedMs < 0.0) return 0.0;
  float duration = receding ? UNFOCUS_MS : WAVE_MS;
  if (elapsedMs >= duration) return 0.0;
  float progress = elapsedMs / duration;
  float crest = receding
    ? UNFOCUS_R0 * (1.0 - progress)
    : WAVE_SPEED * elapsedMs / 1000.0;
  float amp = (1.0 - progress) / (1.0 + crest / AMP_DECAY_LEN);
  if (amp <= 0.0) return 0.0;
  return amp * wavelet(dist - crest);
}

// waveDensity (wave.ts): water ripple for focus/spawn (expanding) and
// unfocus (receding), shrinking fill for collapse. kind 0 = none.
// R6.10 — ripple/recede SUM up to 4 concurrent start times packed in
// t3.xyzw, so rapid chip re-clicks overlap. Collapse keeps t3 =
// (elapsedMs, startRadius).
float waveBonus(float dist, float kind, vec4 t3) {
  if (kind < 0.5) return 0.0;
  if (abs(kind - WAVE_COLLAPSE_K) < 0.5) {
    float elapsedMs = t3.x;
    float startRadius = t3.y;
    if (elapsedMs < 0.0 || elapsedMs >= COLLAPSE_MS) return 0.0;
    float radius = startRadius * (1.0 - elapsedMs / COLLAPSE_MS);
    if (radius <= 0.0 || dist >= radius) return 0.0;
    return 1.0 - dist / radius;
  }
  bool receding = abs(kind - WAVE_RECEDE_K) < 0.5;
  return singleRipple(dist, receding, t3.x)
       + singleRipple(dist, receding, t3.y)
       + singleRipple(dist, receding, t3.z)
       + singleRipple(dist, receding, t3.w);
}

// Combined steady + wave density for record i at world point p,
// clamped to [0, 1] (clamp AFTER summing — deliberate; this is how the original
// CPU algorithm did it). Drives the displayed STAGE/glyph — the wave shades here.
float recordDensity(int i, vec2 p) {
  vec4 rect = texelFetch(uRecords, ivec2(i * 4, 0), 0);
  vec4 t1 = texelFetch(uRecords, ivec2(i * 4 + 1, 0), 0);
  vec4 t2 = texelFetch(uRecords, ivec2(i * 4 + 2, 0), 0);
  vec4 t3 = texelFetch(uRecords, ivec2(i * 4 + 3, 0), 0);
  float d = distToRectBorder(p, rect);
  float steady = (t1.x > 0.0 && d < t1.x) ? 1.0 - d / t1.x : 0.0;
  float bonus = waveBonus(d, t2.w, t3);
  return clamp(steady + bonus, 0.0, 1.0);
}

// R6.7 — OWNERSHIP density for record i: drives the colour lottery
// only. It is the steady aura field PLUS a collapse ghost's wave (a
// ghost has no steady radius — the implosion IS its presence, and it
// renders in the neutral baseline tint, so it must still own its
// cells). Focus/unfocus/spawn ripples are EXCLUDED here on purpose, so
// a passing ripple can never change which aura owns a cell (the
// colour-bleed the wave used to cause). Those ripples still shade via
// recordDensity above.
float recordLotteryDensity(int i, vec2 p) {
  vec4 rect = texelFetch(uRecords, ivec2(i * 4, 0), 0);
  vec4 t1 = texelFetch(uRecords, ivec2(i * 4 + 1, 0), 0);
  vec4 t2 = texelFetch(uRecords, ivec2(i * 4 + 2, 0), 0);
  vec4 t3 = texelFetch(uRecords, ivec2(i * 4 + 3, 0), 0);
  float d = distToRectBorder(p, rect);
  float steady = (t1.x > 0.0 && d < t1.x) ? 1.0 - d / t1.x : 0.0;
  float collapse = (abs(t2.w - WAVE_COLLAPSE_K) < 0.5)
    ? waveBonus(d, t2.w, t3) : 0.0;
  return clamp(steady + collapse, 0.0, 1.0);
}

float recordWeight(int i, float density) {
  vec4 t1 = texelFetch(uRecords, ivec2(i * 4 + 1, 0), 0);
  return density * (t1.y > 0.5 ? FOCUS_BOOST : 1.0);
}

// densityToStage (ramp.ts)
int densityToStage(float d) {
  if (d <= 0.0) return 0;
  if (d >= 1.0) return STAGES - 1;
  return int(d * float(STAGES));
}

void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy); // texel (x,y) IS cell (col,row)
  vec2 worldPos = vec2(
    ((float(cell.x) + 0.5) * uCellCssPx - uViewport.x) / uViewport.z,
    ((float(cell.y) + 0.5) * uCellCssPx - uViewport.y) / uViewport.z
  );
  uint h = cellHash(cell.x, cell.y);
  float seed = float(h) * (1.0 / 4294967296.0);

  // Two-pass weighted lottery — same arbitration as arbitrateIndex
  // (arbitration.ts): total, then accumulate to the seeded target.
  // R6.7 — the lottery runs on STEADY density only, so a passing ripple
  // can never flip which aura owns a cell (the colour-bleed bug).
  float total = 0.0;
  int chatRayOwner = -1;
  for (int i = 0; i < MAX_RECORDS; i++) {
    if (i >= uRecordCount) break;
    float ds = recordLotteryDensity(i, worldPos);
    if (ds > 0.0) {
      vec4 owner = texelFetch(uRecords, ivec2(i * 4 + 1, 0), 0);
      // Keep the one-cell outline intact when a nearby diffuse aura overlaps.
      // Higher-priority labels, arrow clearing and selection still win in B.
      if (int(floor(owner.w)) == ${KIND_CHAT_AURA}
        && isChatRayAtCell(texelFetch(uRecords, ivec2(i * 4, 0), 0))) {
        chatRayOwner = i;
        break;
      }
      total += ds * (owner.y > 0.5 ? FOCUS_BOOST : 1.0);
    }
  }

  int winner = chatRayOwner;
  if (winner < 0 && total > 0.0) {
    float target = seed * total;
    float acc = 0.0;
    int lastPos = -1;
    for (int i = 0; i < MAX_RECORDS; i++) {
      if (i >= uRecordCount) break;
      float ds = recordLotteryDensity(i, worldPos);
      if (ds <= 0.0) continue;
      acc += recordWeight(i, ds);
      lastPos = i;
      if (target < acc) { winner = i; break; }
    }
    if (winner < 0) winner = lastPos; // float safety net
  }

  // R6.7 — stage/glyph from the winner's OWN steady+wave density: the
  // ripple thickens the owner's glyphs (shade) without touching colour.
  // A cell with no steady owner stays baseline (stage 0) — the wave
  // never paints glyphs onto bare background, so it can't recolour
  // distant dots.
  float displayDensity = winner >= 0 ? recordDensity(winner, worldPos) : 0.0;
  int targetStage = densityToStage(displayDensity);

  // Time-based cooling vs the previous frame (coolingEncode.ts spec):
  // heating instant, cooling at uCoolRate stages/sec, floored at the
  // target. History is ignored on reset (resize / zoom / restore).
  float prevStage = 0.0;
  if (uResetHistory == 0) {
    vec4 prev = texelFetch(uPrevState, cell, 0);
    prevStage = prev.r * 255.0 + prev.g;
  }
  float t = float(targetStage);
  float displayed = t >= prevStage
    ? t
    : max(t, prevStage - uDtMs * 0.001 * uCoolRate);

  float alpha = 0.0;
  if (winner >= 0) {
    alpha = texelFetch(uRecords, ivec2(winner * 4 + 1, 0), 0).z;
  }

  float stageInt = floor(displayed);
  outState = vec4(
    stageInt / 255.0,
    displayed - stageInt,
    (winner >= 0 ? float(winner) : 255.0) / 255.0,
    alpha
  );
}
`;

const stageOffsetsGlsl = `int[${STAGES}](${STAGE_OFFSETS.join(', ')})`;
const stageLengthsGlsl = `int[${STAGES}](${STAGE_LENGTHS.join(', ')})`;

export const PASS_B_FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uCellState;
uniform sampler2D uRecords;
uniform sampler2D uAtlas;
uniform vec4 uPalette[${MAX_PALETTE}]; // baseline palette, rgba 0-1
uniform float uAlphaBoost; // theme adjustment shared by all glyph/label kinds
uniform int uPaletteCount;
uniform vec4 uNeutral;          // parsed --scatter-base rgba
uniform float uDeviceCellPx;
uniform float uCellCssPx;
uniform vec3 uViewport;
uniform float uCanvasHpx;       // canvas height in device px
uniform ivec2 uCellsMax;        // cellsX - 1, cellsY - 1
uniform sampler2D uOverlay;     // RGBA8, one texel/cell: R = status glyph
                                // index (0 = none), G = arrow stage-demote
                                // amount, B = status colour index,
                                // A = inherit underlying opacity
uniform vec4 uStatusColors[${MAX_STATUS_COLORS}]; // per-node status colours, rgba 0-1

out vec4 outColor;

const int STAGE_OFFSETS[${STAGES}] = ${stageOffsetsGlsl};
const int STAGE_LENGTHS[${STAGES}] = ${stageLengthsGlsl};

${HASH_GLSL}
${CHAT_RAY_GLSL}

// glyphIndexByHash (ramp.ts) — hash % pool, offset into the flat atlas.
int glyphIndexByHash(int stage, uint h) {
  return STAGE_OFFSETS[stage] + int(h % uint(STAGE_LENGTHS[stage]));
}

uint explainQuestionHash(uint h, uint glyphSeed) {
  h = h ^ (glyphSeed * 2246822507u);
  h = (h ^ (h >> 15u)) * 3266489909u;
  return h ^ (h >> 16u);
}

void main() {
  // Single bottom-up → top-down flip: cell rows count from the top
  // (the per-cell hash depends on the top-down row index).
  float yTop = uCanvasHpx - gl_FragCoord.y;
  int col = min(int(gl_FragCoord.x / uDeviceCellPx), uCellsMax.x);
  int row = min(int(yTop / uDeviceCellPx), uCellsMax.y);

  // Part F/G overlay (one RGBA8 texel per cell): R = status-letter glyph
  // index (0 = none), G = arrow stage-demote amount, B = status colour index.
  vec4 ov = texelFetch(uOverlay, ivec2(col, row), 0);
  int statusG = int(ov.r * 255.0 + 0.5);
  int demote = int(ov.g * 255.0 + 0.5);
  int statusColorIdx = int(ov.b * 255.0 + 0.5);
  int overlayMode = int(ov.a * 255.0 + 0.5);
  bool inheritOverlayOpacity = overlayMode != 0;
  bool groupColorOverlay = overlayMode == ${GROUP_COLOR_RECORD_LOW_BYTE}
    || overlayMode == ${GROUP_COLOR_RECORD_HIGH_BYTE};
  bool projectColorOverlay = overlayMode == ${PROJECT_COLOR_INHERIT_OPACITY_BYTE};
  int groupColorRecordIdx = statusColorIdx
    + (overlayMode == ${GROUP_COLOR_RECORD_HIGH_BYTE} ? 256 : 0);

  // Compute the underlying field cell's glyph + colour FIRST, so a status letter
  // can borrow the exact colour and opacity the field would have at this cell —
  // i.e. it reads as the same glyphs that would otherwise occupy that space.
  int glyphIdx;
  vec4 color;
  {
    vec4 st = texelFetch(uCellState, ivec2(col, row), 0);
    int stage = int(st.r * 255.0 + 0.5);
    int winner = int(st.b * 255.0 + 0.5);
    uint h = cellHash(col, row);
    if (stage == 0) {
      glyphIdx = 0; // '.'
      bool focusedWinner = false;
      if (winner != ${WINNER_NONE}) {
        focusedWinner = texelFetch(uRecords, ivec2(winner * 4 + 1, 0), 0).y > 0.5;
      }
      if (focusedWinner) {
        // Deliberate (from the original CPU algorithm): stage-0 cells inside a FOCUSED aura tint the dot.
        vec3 rgb = texelFetch(uRecords, ivec2(winner * 4 + 2, 0), 0).rgb;
        color = vec4(rgb, st.a);
      } else if (uPaletteCount >= 1) {
        // Ambient tint: far-field dots wear the colours in use. With a single
        // palette entry (lone root node) every dot takes that colour.
        color = uPalette[int(h % uint(uPaletteCount))];
      } else {
        color = uNeutral;
      }
    } else {
      // Part G — under an arrow the cell is demoted to a lighter ramp glyph
      // (fewer stages = sparser char), keeping the cell's own colour.
      glyphIdx = glyphIndexByHash(max(0, stage - demote), h);
      if (winner != ${WINNER_NONE}) {
        vec3 rgb = texelFetch(uRecords, ivec2(winner * 4 + 2, 0), 0).rgb;
        color = vec4(rgb, st.a);
      } else if (uPaletteCount >= 1) {
        // Cooling trail of a vanished/moved aura (fast pan or drag): the cell
        // keeps a fading glyph but has no owner any more. Tint it like the
        // ambient field it is dissolving into — neutral grey here made the
        // trail (and any label sitting on it) flash grey.
        color = uPalette[int(h % uint(uPaletteCount))];
      } else {
        color = uNeutral;
      }
    }
  }

  // Explain auras replace a stable one-in-three sample of dense INNER cells.
  // Both steady density and the displayed/demoted stage must qualify, keeping
  // questions out of sparse outer cells even during ripples. Unfocused questions get
  // a small alpha lift; focused questions match their surrounding glyphs, and
  // the status/arrow-label overlay below keeps final priority.
  {
    vec4 st = texelFetch(uCellState, ivec2(col, row), 0);
    int stage = int(st.r * 255.0 + 0.5);
    int effectiveStage = max(0, stage - demote);
    int winner = int(st.b * 255.0 + 0.5);
    if (winner != ${WINNER_NONE}) {
      vec4 ownerRecord = texelFetch(uRecords, ivec2(winner * 4 + 1, 0), 0);
      float kindSeed = ownerRecord.w;
      int recordKind = int(floor(kindSeed));
      // Arrow/label clearing can suppress rays; text and selection overlays
      // below retain their existing priority, RGB and opacity inheritance.
      if (recordKind == ${KIND_CHAT_AURA}) {
        vec4 rect = texelFetch(uRecords, ivec2(winner * 4, 0), 0);
        vec4 screenRect = vec4(rect.xy * uViewport.z + uViewport.xy, rect.zw * uViewport.z);
        int rayRow = chatRayRow(vec2(col, row), screenRect, uCellCssPx);
        uint glyphSeed = uint(round(fract(kindSeed) * 65536.0));
        // Keep the regular aura; change only the configured random share per row.
        if (shouldUseChatRay(cellHash(col, row), glyphSeed, rayRow)) {
          if (demote == 0) {
            vec2 worldPos = ((vec2(col, row) + 0.5) * uCellCssPx - uViewport.xy) / uViewport.z;
            vec2 direction = (worldPos - rect.xy - rect.zw * 0.5) / max(vec2(1.0), rect.zw * 0.5);
            glyphIdx = abs(direction.x) > 2.0 * abs(direction.y) ? ${boldRayGlyphIndex('_')}
              : abs(direction.y) > 2.0 * abs(direction.x) ? ${boldRayGlyphIndex('|')}
              : direction.x * direction.y > 0.0 ? ${boldRayGlyphIndex('\\')} : ${boldRayGlyphIndex('/')};
          } else {
            glyphIdx = 0;
          }
        }
      }
      if (
        recordKind == ${KIND_EXPLAIN_AURA}
        && effectiveStage >= ${EXPLAIN_QUESTION_MIN_STAGE}
        && effectiveStage <= ${EXPLAIN_QUESTION_MAX_STAGE}
      ) {
        uint glyphSeed = uint(round(fract(kindSeed) * 65536.0));
        uint h = cellHash(col, row);
        vec4 rect = texelFetch(uRecords, ivec2(winner * 4, 0), 0);
        vec2 worldPos = ((vec2(col, row) + 0.5) * uCellCssPx - uViewport.xy) / uViewport.z;
        vec2 outside = max(max(rect.xy - worldPos, worldPos - rect.xy - rect.zw), vec2(0.0));
        float steadyDensity = ownerRecord.x > 0.0 ? max(0.0, 1.0 - length(outside) / ownerRecord.x) : 0.0;
        int steadyStage = min(${STAGES - 1}, int(steadyDensity * ${fmt(STAGES)}));
        if (steadyStage >= ${EXPLAIN_QUESTION_MIN_STAGE}
          && explainQuestionHash(h, glyphSeed) % ${EXPLAIN_QUESTION_SAMPLE_EVERY}u == 0u) {
          glyphIdx = ${QUESTION_GLYPH_INDEX};
          if (ownerRecord.y < 0.5 && statusG == 0) {
            color.a = min(1.0, color.a + ${EXPLAIN_QUESTION_UNFOCUSED_ALPHA_BOOST.toFixed(1)});
          }
        }
      }
    }
  }

  // Status text substitutes only the glyph SHAPE: it keeps the field cell's
  // colour + opacity computed above (so it blends with the surrounding aura),
  // and is exempt from the arrow/halo demote that the field glyph received.
  if (statusG != 0) {
    glyphIdx = statusG;
    if (groupColorOverlay) {
      float underlyingAlpha = color.a;
      vec4 groupRecord = texelFetch(uRecords, ivec2(groupColorRecordIdx * 4 + 2, 0), 0);
      color.rgb = groupRecord.rgb;
      color.a = underlyingAlpha;
    } else if (projectColorOverlay) {
      float underlyingAlpha = color.a;
      color.rgb = uStatusColors[statusColorIdx].rgb;
      color.a = underlyingAlpha;
    }
    // Generation/status text retains its legibility floor. Arrow and drag
    // labels set overlay A, so their opacity remains exactly that of the aura
    // glyph they replace.
    if (!inheritOverlayOpacity) {
      color.a = max(${OVERLAY_MIN_ALPHA.toFixed(2)}, color.a);
    }
  }

  // In-cell device pixel → atlas texel (clamped: the grid's partial
  // edge cells reuse the last cell's state but must not bleed into
  // the neighbouring atlas glyph).
  float inX = clamp(gl_FragCoord.x - float(col) * uDeviceCellPx, 0.0, uDeviceCellPx - 1.0);
  float inY = clamp(yTop - float(row) * uDeviceCellPx, 0.0, uDeviceCellPx - 1.0);
  float glyphA = texelFetch(uAtlas, ivec2(int(float(glyphIdx) * uDeviceCellPx + inX), int(inY)), 0).a;

  // Increase the assembled ink once, including status floors and inherited
  // label alpha. Keep fully opaque ink at 1 and empty/antialiased pixels intact.
  float a = glyphA * min(1.0, color.a + uAlphaBoost);
  outColor = vec4(color.rgb * a, a); // premultiplied over the white host bg
}
`;
