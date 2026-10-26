'use client';

import { Image as ImageIcon, SquareMousePointer } from 'lucide-react';
import { useGenerationPulseSync } from '@/hooks/useGenerationPulseSync';

interface Props {
  kind: 'image' | 'interactive';
}

/** Shared frosted loading surface. Geometry is supplied by the owning media or
 * interactive container; the blur, wash, icon treatment, and pulse stay exact. */
export function GenerationMediaSkeleton({ kind }: Props) {
  const pulseStyle = useGenerationPulseSync(true);
  const interactive = kind === 'interactive';
  const Icon = interactive ? SquareMousePointer : ImageIcon;
  return (
    <div
      className={interactive
        ? 'sc-interactive-generation-skeleton'
        : 'sc-image-generation-skeleton'}
      role="status"
      aria-label={interactive ? 'Loading interactive program' : 'Generating image'}
      style={pulseStyle}
    >
      <div className="sc-generation-skeleton-frame">
        <Icon
          className="sc-generation-skeleton-icon"
          size={interactive ? 56 : 32}
          strokeWidth={1.6}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
