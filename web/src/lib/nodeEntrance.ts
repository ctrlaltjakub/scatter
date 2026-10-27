import { useMemo, type CSSProperties } from 'react';
import { birthIsPending, NODE_ENTRANCE_MS, type NodeBirth } from '@/store/useNodeBirthStore';

/** A shared clock keeps a card, its detached panel and its arrows in phase.
 * No transform tween: geometry and hit targets always use real coordinates. */
function nodeEntranceStyle(birth?: NodeBirth): CSSProperties {
  if (birthIsPending(birth)) return { visibility: 'hidden', opacity: 0, pointerEvents: 'none', transition: 'none' };
  if (birth?.revealedAt != null) return {
    animationName: 'node-enter', animationDuration: `${NODE_ENTRANCE_MS}ms`,
    animationTimingFunction: 'ease-out', animationFillMode: 'backwards',
    animationDelay: `${-Math.min(NODE_ENTRANCE_MS, Math.max(0, performance.now() - birth.revealedAt))}ms`,
  };
  return {};
}

export function useNodeEntranceStyle(birth?: NodeBirth): CSSProperties {
  // Freeze the animation offset for this phase. Recomputing it on physics
  // renders would advance the fade twice (CSS time plus a moving offset).
  return useMemo(() => nodeEntranceStyle(birth), [birth]);
}
