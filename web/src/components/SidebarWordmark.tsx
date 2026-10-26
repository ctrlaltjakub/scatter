'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { colorToCss, resolveColorHex } from '@/lib/groupColor';
import { generateWordmarkPattern, type WordmarkGlyphStyle } from '@/lib/sidebarWordmark';
import { useGraphStore } from '@/store/useGraphStore';
import { LANDING_URL, releaseChannel } from '@/lib/deployment';

const LETTERS = [...'SCATTER'];
const INITIAL_PATTERN: WordmarkGlyphStyle[] = LETTERS.map(() => ({
  color: 'var(--text)',
  brightness: 1,
}));

interface SidebarWordmarkProps {
  /** Runtime palette used by the project-restoration shell. */
  paletteOverride?: readonly string[];
  /** Changes force a fresh arrangement even when the two colors are unchanged. */
  reshuffleToken?: number;
}

export function SidebarWordmark({
  paletteOverride,
  reshuffleToken = 0,
}: SidebarWordmarkProps = {}) {
  const projectColor = useGraphStore((state) => state.project?.color ?? null);
  const groups = useGraphStore((state) => state.project?.groups ?? null);
  const selection = useGraphStore((state) => state.project?.selection ?? null);
  const projectPalette = useMemo(() => {
    const raw = [projectColor, ...Object.values(groups ?? {}).map((group) => group.color)]
      .filter((color): color is string => Boolean(color));
    const seen = new Set<string>();
    return raw.filter((color) => {
      const resolved = resolveColorHex(color).toLowerCase();
      if (seen.has(resolved)) return false;
      seen.add(resolved);
      return true;
    }).map(colorToCss);
  }, [groups, projectColor]);
  const palette = paletteOverride ?? projectPalette;
  const paletteKey = palette.join('|');
  const previousPaletteRef = useRef<string | null>(null);
  const previousSelectionRef = useRef<readonly string[] | null>(null);
  const previousReshuffleRef = useRef(reshuffleToken);
  const [pattern, setPattern] = useState(() => (
    paletteOverride ? generateWordmarkPattern(paletteOverride) : INITIAL_PATTERN
  ));

  useEffect(() => {
    const paletteChanged = previousPaletteRef.current !== paletteKey;
    const nodeGainedFocus = !paletteOverride
      && previousSelectionRef.current !== selection
      && (selection?.length ?? 0) > 0;
    const reshuffleRequested = previousReshuffleRef.current !== reshuffleToken;
    previousPaletteRef.current = paletteKey;
    previousSelectionRef.current = selection;
    previousReshuffleRef.current = reshuffleToken;
    if (paletteChanged || nodeGainedFocus || reshuffleRequested) {
      setPattern(generateWordmarkPattern(palette));
    }
  }, [palette, paletteKey, paletteOverride, reshuffleToken, selection]);

  return (
    <a href={LANDING_URL} className="app-wordmark" aria-label="Scatter landing page">
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
