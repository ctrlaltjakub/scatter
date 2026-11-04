#version 300 es
// Frozen pre-optimization compositor (a0c3dc2). Test-only pixel/performance oracle.
precision highp float;
precision highp int;

uniform sampler2D uCellState;
uniform sampler2D uRecords;
uniform sampler2D uAtlas;
uniform vec4 uPalette[16]; // baseline palette, rgba 0-1
uniform float uAlphaBoost; // theme adjustment shared by all glyph/label kinds
uniform float uOpacity; // global/background user multiplier
uniform float uLabelOpacity; // follows uOpacity unless the independent control is enabled
uniform bool uPointOpacityTrails;
uniform sampler2D uOpacityHistory;
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
uniform vec4 uStatusColors[8]; // per-node status colours, rgba 0-1

out vec4 outColor;

const int STAGE_OFFSETS[9] = int[9](0, 1, 3, 4, 5, 7, 9, 11, 13);
const int STAGE_LENGTHS[9] = int[9](1, 2, 1, 1, 2, 2, 2, 2, 1);


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


float auraAreaFraction(float distance, vec2 size, float radius) {
  if (radius <= 0.0) return 1.0;
  float d = clamp(distance, 0.0, radius);
  float perimeter = 2.0 * (size.x + size.y);
  return (perimeter * d + 3.141592653589793 * d * d)
    / (perimeter * radius + 3.141592653589793 * radius * radius);
}

float auraOpacityTier(uint cellSeed, float areaFraction) {
  uint h = cellSeed ^ 2654435769u;
  h = (h ^ (h >> 16u)) * 2246822507u;
  h = h ^ (h >> 13u);
  float random = float(h) * (1.0 / 4294967296.0);
  float area = clamp(areaFraction, 0.0, 1.0);
  float full = 0.6000036865500631 * exp(-12.0 * area);
  return random < full ? 1.0 : 0.5;
}


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
  bool groupColorOverlay = overlayMode == 254
    || overlayMode == 253;
  bool projectColorOverlay = overlayMode == 252;
  int groupColorRecordIdx = statusColorIdx
    + (overlayMode == 253 ? 256 : 0);

  // Compute the underlying field cell's glyph + colour FIRST, so a status letter
  // can borrow the exact colour and opacity the field would have at this cell —
  // i.e. it reads as the same glyphs that would otherwise occupy that space.
  int glyphIdx;
  vec4 color;
  float scatteredOpacity = 1.0;
  bool pointCore = false;
  {
    vec4 st = texelFetch(uCellState, ivec2(col, row), 0);
    int stage = int(st.r * 255.0 + 0.5);
    int winner = int(st.b * 255.0 + 0.5);
    uint h = cellHash(col, row);
    if (statusG == 0) {
      if (uPointOpacityTrails) {
        vec2 history = texelFetch(uOpacityHistory, ivec2(col, row), 0).rg;
        float proximity = clamp((history.r * 255.0 + history.g) / 8.0, 0.0, 1.0);
        // Point-aura area percentile is (distance / radius)^2. Its cooled
        // proximity persists after the orb moves on, including ownerless cells.
        float distanceFraction = 1.0 - proximity;
        scatteredOpacity = proximity > 0.0 ? auraOpacityTier(h, distanceFraction * distanceFraction) : 0.5;
        // The core is just the innermost part of the EXISTING cooled field.
        // No separate opacity history or fade: cells stop being core cells as
        // their normal density cools, preserving the established glyph wake.
        float radius = winner != 255
          ? texelFetch(uRecords, ivec2(winner * 4 + 1, 0), 0).x : 300.0;
        pointCore = proximity > 0.0
          && distanceFraction * radius * uViewport.z <= 24.0;
      } else if (winner != 255) {
        vec4 rect = texelFetch(uRecords, ivec2(winner * 4, 0), 0);
        vec4 owner = texelFetch(uRecords, ivec2(winner * 4 + 1, 0), 0);
        // Collapse ghosts have no steady radius; use their original footprint.
        float radius = owner.x > 0.0 ? owner.x
          : texelFetch(uRecords, ivec2(winner * 4 + 3, 0), 0).y;
        vec2 worldPos = ((vec2(col, row) + 0.5) * uCellCssPx - uViewport.xy) / uViewport.z;
        vec2 outside = max(max(rect.xy - worldPos, worldPos - rect.xy - rect.zw), vec2(0.0));
        scatteredOpacity = auraOpacityTier(h, auraAreaFraction(length(outside), rect.zw, radius));
      } else if (stage > 0) {
        // A vanished aura's cooling trail is still an aura effect, not text.
        scatteredOpacity = auraOpacityTier(h, 1.0);
      } else {
        // Plain ambient dots outside all auras are uniformly half opacity.
        scatteredOpacity = 0.5;
      }
    }
    if (stage == 0) {
      glyphIdx = 0; // '.'
      bool focusedWinner = false;
      if (winner != 255) {
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
      if (winner != 255) {
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
    if (winner != 255) {
      vec4 ownerRecord = texelFetch(uRecords, ivec2(winner * 4 + 1, 0), 0);
      float kindSeed = ownerRecord.w;
      int recordKind = int(floor(kindSeed));
      // Arrow/label clearing can suppress rays; text and selection overlays
      // below retain their existing priority, RGB and opacity inheritance.
      if (recordKind == 3) {
        vec4 rect = texelFetch(uRecords, ivec2(winner * 4, 0), 0);
        vec4 screenRect = vec4(rect.xy * uViewport.z + uViewport.xy, rect.zw * uViewport.z);
        int rayRow = chatRayRow(vec2(col, row), screenRect, uCellCssPx);
        uint glyphSeed = uint(round(fract(kindSeed) * 65536.0));
        // Keep the regular aura; change only the configured random share per row.
        if (shouldUseChatRay(cellHash(col, row), glyphSeed, rayRow)) {
          if (demote == 0) {
            vec2 worldPos = ((vec2(col, row) + 0.5) * uCellCssPx - uViewport.xy) / uViewport.z;
            vec2 direction = (worldPos - rect.xy - rect.zw * 0.5) / max(vec2(1.0), rect.zw * 0.5);
            glyphIdx = abs(direction.x) > 2.0 * abs(direction.y) ? 66
              : abs(direction.y) > 2.0 * abs(direction.x) ? 67
              : direction.x * direction.y > 0.0 ? 68 : 69;
          } else {
            glyphIdx = 0;
          }
        }
      }
      if (
        recordKind == 2
        && effectiveStage >= 6
        && effectiveStage <= 8
      ) {
        uint glyphSeed = uint(round(fract(kindSeed) * 65536.0));
        uint h = cellHash(col, row);
        vec4 rect = texelFetch(uRecords, ivec2(winner * 4, 0), 0);
        vec2 worldPos = ((vec2(col, row) + 0.5) * uCellCssPx - uViewport.xy) / uViewport.z;
        vec2 outside = max(max(rect.xy - worldPos, worldPos - rect.xy - rect.zw), vec2(0.0));
        float steadyDensity = ownerRecord.x > 0.0 ? max(0.0, 1.0 - length(outside) / ownerRecord.x) : 0.0;
        int steadyStage = min(8, int(steadyDensity * 9.0));
        if (steadyStage >= 6
          && explainQuestionHash(h, glyphSeed) % 3u == 0u) {
          glyphIdx = 59;
          if (ownerRecord.y < 0.5 && statusG == 0) {
            color.a = min(1.0, color.a + 0.1);
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
      color.a = max(0.80, color.a);
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
  float inkAlpha = min(1.0, color.a + uAlphaBoost);
  float opacity = statusG != 0 ? uLabelOpacity : uOpacity;
  // Apply the random tiers after the slider's saturation, so even at 200%
  // the half-opacity cells retain their contrast. Atlas antialiasing stays intact.
  float fieldAlpha = clamp(inkAlpha * opacity, 0.0, 1.0) * scatteredOpacity;
  // Opaque ink only in the existing field's small core. The opacity slider,
  // atlas antialiasing and functional overlays keep their established behavior.
  float a = glyphA * (pointCore ? clamp(opacity, 0.0, 1.0) : fieldAlpha);
  outColor = vec4(color.rgb * a, a); // premultiplied over the white host bg
}
