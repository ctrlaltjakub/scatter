'use client';
import { useMemo, type CSSProperties } from 'react';
import type { ImageRegion } from '@/store/types';
import { imageRegionPaths } from '@/lib/imageRegions';

export function ImageRegionOverlay({ regions, style }: { regions: readonly ImageRegion[]; style?: CSSProperties }) {
  const paths = useMemo(() => imageRegionPaths(regions), [regions]);
  if (!paths.fill) return null;
  return (
    <svg className="image-region-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" style={style} aria-hidden="true">
      <path d={paths.fill} className="image-region-fill" />
      <path d={paths.outline} className="image-region-outline-halo" vectorEffect="non-scaling-stroke" />
      <path d={paths.outline} className="image-region-outline" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
