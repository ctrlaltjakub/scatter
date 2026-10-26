'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ImageOff } from 'lucide-react';
import type { FreeImageRecommendation } from '@/store/types';
import { freeImageDisplayCandidates, freeImageSourceId } from '@/lib/freeImageRecommendations';

export function ResilientFreeImage({
  result,
  alt,
  className,
  style,
  loading = 'lazy',
  draggable = false,
  onReady,
}: {
  result: FreeImageRecommendation;
  alt: string;
  className?: string;
  style?: CSSProperties;
  loading?: 'eager' | 'lazy';
  draggable?: boolean;
  onReady?: (image: HTMLImageElement, resolvedUrl: string) => void;
}) {
  const urls = useMemo(() => freeImageDisplayCandidates(result), [result]);
  const identity = `${freeImageSourceId(result)}\n${urls.join('\n')}`;
  const [state, setState] = useState({ identity, index: 0, loaded: false });
  const current = state.identity === identity ? state : { identity, index: 0, loaded: false };

  useEffect(() => {
    setState({ identity, index: 0, loaded: false });
  }, [identity]);

  const url = urls[current.index];
  if (!url) {
    return <span className="free-image-unavailable" role="img" aria-label={`${alt}: preview unavailable`}><ImageOff size={28} /></span>;
  }
  return (
    <img
      src={url}
      alt={alt}
      width={result.width}
      height={result.height}
      loading={loading}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={draggable}
      className={`resilient-free-image ${className ?? ''}${current.loaded ? ' is-loaded' : ''}`.trim()}
      style={style}
      onError={() => setState((previous) => ({
        identity,
        index: Math.min((previous.identity === identity ? previous.index : 0) + 1, urls.length),
        loaded: false,
      }))}
      onLoad={(event) => {
        const image = event.currentTarget;
        const reveal = () => {
          setState((previous) => previous.identity === identity
            ? { ...previous, loaded: true }
            : previous);
          onReady?.(image, url);
        };
        if (typeof image.decode === 'function') void image.decode().then(reveal, reveal);
        else reveal();
      }}
    />
  );
}
