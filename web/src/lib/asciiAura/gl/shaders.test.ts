import { describe, expect, test } from 'vitest';
import { EXPLAIN_QUESTION_MAX_STAGE, EXPLAIN_QUESTION_MIN_STAGE, EXPLAIN_QUESTION_SAMPLE_EVERY, KIND_CHAT_AURA } from './recordPacking';
import { boldRayGlyphIndex } from './atlasLayout';
import {
  EXPLAIN_QUESTION_UNFOCUSED_ALPHA_BOOST,
  OVERLAY_MIN_ALPHA,
  PASS_B_FRAGMENT_SRC,
  PASS_A_FRAGMENT_SRC,
} from './shaders';

describe('explain question glyph density gate', () => {
  test('uses the demoted effective stage and leaves status overlay last', () => {
    const effective = PASS_B_FRAGMENT_SRC.indexOf('int effectiveStage = max(0, stage - demote);');
    const lower = PASS_B_FRAGMENT_SRC.indexOf(`effectiveStage >= ${EXPLAIN_QUESTION_MIN_STAGE}`);
    const upper = PASS_B_FRAGMENT_SRC.indexOf(`effectiveStage <= ${EXPLAIN_QUESTION_MAX_STAGE}`);
    const steady = PASS_B_FRAGMENT_SRC.indexOf(`if (steadyStage >= ${EXPLAIN_QUESTION_MIN_STAGE}`);
    const question = PASS_B_FRAGMENT_SRC.indexOf(`explainQuestionHash(h, glyphSeed) % ${EXPLAIN_QUESTION_SAMPLE_EVERY}u == 0u)`);
    const status = PASS_B_FRAGMENT_SRC.indexOf('if (statusG != 0)');
    expect(effective).toBeGreaterThan(-1);
    expect(lower).toBeGreaterThan(effective);
    expect(upper).toBeGreaterThan(lower);
    expect(steady).toBeGreaterThan(upper);
    expect(question).toBeGreaterThan(steady);
    expect(status).toBeGreaterThan(question);
  });

  test('boosts only unfocused question glyphs and excludes status overlays', () => {
    const question = PASS_B_FRAGMENT_SRC.indexOf(
      `explainQuestionHash(h, glyphSeed) % ${EXPLAIN_QUESTION_SAMPLE_EVERY}u == 0u)`,
    );
    const focusGate = PASS_B_FRAGMENT_SRC.indexOf('ownerRecord.y < 0.5', question);
    const overlayGate = PASS_B_FRAGMENT_SRC.indexOf('statusG == 0', focusGate);
    const boost = PASS_B_FRAGMENT_SRC.indexOf(
      `color.a = min(1.0, color.a + ${EXPLAIN_QUESTION_UNFOCUSED_ALPHA_BOOST.toFixed(1)});`,
      overlayGate,
    );
    const status = PASS_B_FRAGMENT_SRC.indexOf('if (statusG != 0)', boost);
    expect(question).toBeGreaterThan(-1);
    expect(focusGate).toBeGreaterThan(question);
    expect(overlayGate).toBeGreaterThan(focusGate);
    expect(boost).toBeGreaterThan(overlayGate);
    expect(status).toBeGreaterThan(boost);
  });
});

describe('chat ray shader integration', () => {
  test('uses heavier glyph variants only for chat rays', () => {
    const rays = PASS_B_FRAGMENT_SRC.slice(
      PASS_B_FRAGMENT_SRC.indexOf(`if (recordKind == ${KIND_CHAT_AURA})`),
      PASS_B_FRAGMENT_SRC.indexOf('uint h = cellHash(col, row);', PASS_B_FRAGMENT_SRC.indexOf(`if (recordKind == ${KIND_CHAT_AURA})`)),
    );
    for (const glyph of ['_', '|', '\\', '/'] as const) {
      expect(rays).toContain(` ${boldRayGlyphIndex(glyph)}`);
    }
  });
  test('preserves ordinary aura density, waves and cooling outside the ray row', () => {
    const densityFunctions = PASS_A_FRAGMENT_SRC.slice(
      PASS_A_FRAGMENT_SRC.indexOf('float recordDensity('),
      PASS_A_FRAGMENT_SRC.indexOf('float recordWeight('),
    );
    expect(densityFunctions).not.toContain('chatRay');
    expect(densityFunctions).not.toContain('isChatRay');
    expect(densityFunctions).toContain('return clamp(steady + bonus, 0.0, 1.0);');
    expect(PASS_A_FRAGMENT_SRC).toContain('prevStage = prev.r * 255.0 + prev.g;');
    expect(PASS_A_FRAGMENT_SRC).not.toContain('chatWinner');
    expect(PASS_A_FRAGMENT_SRC).toContain('&& isChatRayAtCell(texelFetch(uRecords, ivec2(i * 4, 0), 0))');
    expect(PASS_A_FRAGMENT_SRC).toContain('if (winner < 0 && total > 0.0)');
  });

  test('rays yield to arrow clearing and the final text/selection overlay', () => {
    const chat = PASS_B_FRAGMENT_SRC.indexOf(`if (recordKind == ${KIND_CHAT_AURA})`);
    const ray = PASS_B_FRAGMENT_SRC.indexOf('if (shouldUseChatRay(cellHash(col, row), glyphSeed, rayRow))', chat);
    const clearing = PASS_B_FRAGMENT_SRC.indexOf('if (demote == 0)', ray);
    expect(ray).toBeGreaterThan(-1);
    expect(clearing).toBeGreaterThan(ray);
    expect(PASS_B_FRAGMENT_SRC.indexOf('if (statusG != 0)')).toBeGreaterThan(clearing);
  });
});

describe('overlay opacity modes', () => {
  test('applies the theme boost once after all opacity overrides, capped before glyph coverage', () => {
    const floor = PASS_B_FRAGMENT_SRC.indexOf(`color.a = max(${OVERLAY_MIN_ALPHA.toFixed(2)}, color.a);`);
    const boost = 'float a = glyphA * min(1.0, color.a + uAlphaBoost);';
    expect(PASS_B_FRAGMENT_SRC).toContain('uniform float uAlphaBoost;');
    expect(PASS_B_FRAGMENT_SRC.indexOf(boost)).toBeGreaterThan(floor);
    expect(PASS_B_FRAGMENT_SRC.split('color.a + uAlphaBoost')).toHaveLength(2);
    expect(PASS_B_FRAGMENT_SRC.indexOf('outColor = vec4(color.rgb * a, a);'))
      .toBeGreaterThan(PASS_B_FRAGMENT_SRC.indexOf(boost));
  });

  test('lets shape-only labels inherit aura opacity while status text keeps its floor', () => {
    const flag = PASS_B_FRAGMENT_SRC.indexOf('bool inheritOverlayOpacity = overlayMode != 0;');
    const overlay = PASS_B_FRAGMENT_SRC.indexOf('if (statusG != 0)', flag);
    const inheritedGate = PASS_B_FRAGMENT_SRC.indexOf('if (!inheritOverlayOpacity)', overlay);
    const floor = PASS_B_FRAGMENT_SRC.indexOf(
      `color.a = max(${OVERLAY_MIN_ALPHA.toFixed(2)}, color.a);`,
      inheritedGate,
    );
    expect(flag).toBeGreaterThan(-1);
    expect(overlay).toBeGreaterThan(flag);
    expect(inheritedGate).toBeGreaterThan(overlay);
    expect(floor).toBeGreaterThan(inheritedGate);
  });

  test('takes group-label RGB from its aura record without replacing the underlying alpha', () => {
    const groupMode = PASS_B_FRAGMENT_SRC.indexOf('bool groupColorOverlay =');
    const priorAlpha = PASS_B_FRAGMENT_SRC.indexOf('float underlyingAlpha = color.a;', groupMode);
    const recordColor = PASS_B_FRAGMENT_SRC.indexOf('color.rgb = groupRecord.rgb;', priorAlpha);
    const restoreAlpha = PASS_B_FRAGMENT_SRC.indexOf('color.a = underlyingAlpha;', recordColor);
    expect(groupMode).toBeGreaterThan(-1);
    expect(priorAlpha).toBeGreaterThan(groupMode);
    expect(recordColor).toBeGreaterThan(priorAlpha);
    expect(restoreAlpha).toBeGreaterThan(recordColor);
  });
});
