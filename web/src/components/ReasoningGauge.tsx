import type { CSSProperties } from 'react';
import type { ReasoningEffort } from '@/store/types';

// Fixed positions keep the meaning stable when switching model catalogs.
// The dial is qualitative; it does not imply a token budget or percentage.
const NEEDLE_ANGLES: Record<ReasoningEffort, number> = {
  off: -100, minimal: -75, low: -45, medium: 0, high: 45, xhigh: 75, max: 100,
};

/** Lucide's gauge outline, with only its needle position changed. */
export function ReasoningGauge({ effort }: { effort?: ReasoningEffort }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    className="lucide lucide-gauge sc-reasoning-gauge" aria-hidden="true" focusable="false">
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    <path d="M12 14V8.343" className="sc-reasoning-needle"
      style={{ '--needle-angle': `${NEEDLE_ANGLES[effort ?? 'off']}deg` } as CSSProperties} />
  </svg>;
}
