'use client';

import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { generationPulseDelay } from '@/lib/generationPulse';

type PulseStyle = CSSProperties & { '--sc-generation-pulse-delay': string };

/** Re-sync the shared loading phase whenever this indicator becomes active. */
export function useGenerationPulseSync(active: boolean): PulseStyle | undefined {
  const [style, setStyle] = useState<PulseStyle>();
  useLayoutEffect(() => {
    setStyle(active
      ? { '--sc-generation-pulse-delay': generationPulseDelay() }
      : undefined);
  }, [active]);
  return style;
}
