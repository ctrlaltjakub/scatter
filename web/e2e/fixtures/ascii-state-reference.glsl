#version 300 es
// Frozen pre-optimization cell state (a0c3dc2). Test-only cooling/appearance oracle.
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
uniform bool uPointOpacityTrails;
uniform sampler2D uPrevOpacityHistory; // optional point-orb proximity, stage + fraction

layout(location = 0) out vec4 outState;
layout(location = 1) out vec2 outOpacityHistory;

const int MAX_RECORDS = 512;
const float FOCUS_BOOST = 2.33;
const float WAVE_MS = 650.0;
const float WAVE_SPEED = 280.0;
const float UNFOCUS_MS = 450.0;
const float UNFOCUS_R0 = 200.0;
const float RIPPLE_LAMBDA = 90.0;
const float RIPPLE_SIGMA = 50.0;
const float AMP_DECAY_LEN = 240.0;
const float TWO_PI = 6.28318530718;
const float COLLAPSE_MS = 250.0;
const int STAGES = 9;
const float KIND_GHOST = 1.0;
const float WAVE_RIPPLE_K = 1.0;
const float WAVE_COLLAPSE_K = 2.0;
const float WAVE_RECEDE_K = 3.0;


uint cellHash(int cx, int cy) {
  uint h = uint(cx) * 374761393u;
  h = h + uint(cy) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return h;
}


const uint CHAT_RAY_PERCENTAGES[3] = uint[3](50u, 33u, 10u);

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
  if (rayRow < 1 || rayRow > 3) return false;
  h = h ^ (glyphSeed * 2246822507u) ^ 2722868949u;
  h = (h ^ (h >> 15u)) * 3266489909u;
  h = h ^ (h >> 16u);
  return h % 100u < CHAT_RAY_PERCENTAGES[rayRow - 1];
}


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
  int priorityOwner = -1;
  for (int i = 0; i < MAX_RECORDS; i++) {
    if (i >= uRecordCount) break;
    float ds = recordLotteryDensity(i, worldPos);
    if (ds > 0.0) {
      vec4 owner = texelFetch(uRecords, ivec2(i * 4 + 1, 0), 0);
      if (uPointOpacityTrails) {
        vec4 rect = texelFetch(uRecords, ivec2(i * 4, 0), 0);
        if (all(equal(rect.zw, vec2(0.0)))
          && length(worldPos - rect.xy) * uViewport.z <= 24.0) {
          // A neighboring orb's diffuse aura must not punch holes in the core
          // or steal its color. Only restoration point scenes use this path.
          priorityOwner = i;
          break;
        }
      }
      // Keep the one-cell outline intact when a nearby diffuse aura overlaps.
      // Higher-priority labels, arrow clearing and selection still win in B.
      if (int(floor(owner.w)) == 3
        && isChatRayAtCell(texelFetch(uRecords, ivec2(i * 4, 0), 0))) {
        priorityOwner = i;
        break;
      }
      total += ds * (owner.y > 0.5 ? FOCUS_BOOST : 1.0);
    }
  }

  int winner = priorityOwner;
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

  outOpacityHistory = vec2(0.0);
  if (uPointOpacityTrails) {
    // Track steady proximity, not ripple density: recoloring must not paint
    // bright rings. Keep full stage/fraction precision at every refresh rate.
    float target = (winner >= 0 ? recordLotteryDensity(winner, worldPos) : 0.0)
      * float(STAGES - 1);
    vec2 previous = uResetHistory == 0 ? texelFetch(uPrevOpacityHistory, cell, 0).rg : vec2(0.0);
    float prior = previous.r * 255.0 + previous.g;
    float cooled = max(target, prior - uDtMs * 0.001 * uCoolRate);
    outOpacityHistory = vec2(floor(cooled) / 255.0, fract(cooled));
  }
}
