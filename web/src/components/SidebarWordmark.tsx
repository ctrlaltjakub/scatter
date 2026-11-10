'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colorToCss, mutedAccentHex, resolveColorHex } from '@/lib/groupColor';
import { generateWordmarkPattern, type WordmarkGlyphStyle } from '@/lib/sidebarWordmark';
import { useGraphStore } from '@/store/useGraphStore';
import { LANDING_URL, releaseChannel } from '@/lib/deployment';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';

const LETTERS = [...'SCATTER'];
const INITIAL_PATTERN: WordmarkGlyphStyle[] = LETTERS.map(() => ({
  color: 'var(--text)',
  brightness: 1,
}));

interface SidebarWordmarkProps {
  /** A palette for screens without a loaded project. */
  paletteOverride?: readonly string[];
  showEveryColor?: boolean;
  /** Changes force a fresh arrangement even when the two colors are unchanged. */
  reshuffleToken?: number;
}

export function SidebarWordmark({
  paletteOverride,
  showEveryColor = false,
  reshuffleToken = 0,
}: SidebarWordmarkProps = {}) {
  const projectColor = useGraphStore((state) => state.project?.color ?? null);
  const groups = useGraphStore((state) => state.project?.groups ?? null);
  const selection = useGraphStore((state) => state.project?.selection ?? null);
  const hueShift = useSettingsStore(state => state.accentHueShift);
  const desaturate = useSettingsStore(state => state.accentDesaturate);
  const darken = useSettingsStore(state => state.accentDarken);
  const theme = useResolvedTheme();
  const projectPalette = useMemo(() => {
    const raw = [projectColor, ...Object.values(groups ?? {}).map((group) => group.color)]
      .filter((color): color is string => Boolean(color));
    const seen = new Set<string>();
    const distinct = raw.filter((color) => {
      const resolved = resolveColorHex(color).toLowerCase();
      if (seen.has(resolved)) return false;
      seen.add(resolved);
      return true;
    });
    const colors = distinct.map(colorToCss);
    // Reuse the canvas controls' accent, including theme and appearance settings,
    // so a project with no additional group colors still has a two-color logo.
    if (distinct.length === 1) colors.push(mutedAccentHex(distinct[0], hueShift, desaturate, darken, theme));
    return colors;
  }, [groups, projectColor, hueShift, desaturate, darken, theme]);
  const palette = paletteOverride ?? projectPalette;
  const paletteKey = palette.join('|');
  const previousPaletteRef = useRef<string | null>(null);
  const previousSelectionRef = useRef<readonly string[] | null>(null);
  const previousReshuffleRef = useRef(reshuffleToken);
  const [hovered, setHovered] = useState(false);
  const draw = useCallback(() => generateWordmarkPattern(palette, Math.random, showEveryColor), [palette, showEveryColor]);
  const [pattern, setPattern] = useState(() => paletteOverride ? draw() : INITIAL_PATTERN);

  useEffect(() => {
    const paletteChanged = previousPaletteRef.current !== paletteKey;
    const focusChanged = !paletteOverride
      && previousSelectionRef.current !== selection
      && ((selection?.length ?? 0) > 0 || (previousSelectionRef.current?.length ?? 0) > 0);
    const reshuffleRequested = previousReshuffleRef.current !== reshuffleToken;
    previousPaletteRef.current = paletteKey;
    previousSelectionRef.current = selection;
    previousReshuffleRef.current = reshuffleToken;
    if (paletteChanged || focusChanged || reshuffleRequested) {
      setPattern(draw());
    }
  }, [draw, paletteKey, paletteOverride, reshuffleToken, selection]);

  useEffect(() => {
    if (!hovered) return;
    const timer = window.setInterval(() => setPattern(draw()), 500);
    return () => window.clearInterval(timer);
  }, [hovered, draw]);

  return (
    <a href={LANDING_URL} target="_blank" rel="noopener noreferrer"
      className="app-wordmark" data-link-control aria-label="Scatter landing page (opens in a new tab)"
      onMouseEnter={() => { setHovered(true); setPattern(draw()); }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setPattern(draw())}>
      {LETTERS.map((letter, index) => {
        const glyph = pattern[index] ?? INITIAL_PATTERN[index]!;
        return (
          <span
            key={`${letter}-${index}`}
            className="app-wordmark-letter"
            aria-hidden="true"
            style={{ color: glyph.color, filter: `brightness(${glyph.brightness})` }}
          >
            {letter}
          </span>
        );
      })}
      {releaseChannel() === 'beta' && <small className="app-release-label">Beta</small>}
    </a>
  );
}
