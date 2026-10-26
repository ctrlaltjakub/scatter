'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Group } from '@/store/types';
import { GroupTitleText } from './GroupTitleText';

const LINE_HEIGHT_PX = 18;
const TWO_LINE_HEIGHT_PX = 36;
const LOOP_SPEED_PX_PER_SECOND = 12;

export function GroupNameDisplay({ name, active, titleGeneration }: { name: string; active: boolean; titleGeneration?: Group['titleGeneration'] }) {
  const measureRef = useRef<HTMLSpanElement>(null);
  const [naturalHeight, setNaturalHeight] = useState(LINE_HEIGHT_PX);

  useLayoutEffect(() => {
    const measure = () => {
      const next = measureRef.current?.scrollHeight || LINE_HEIGHT_PX;
      setNaturalHeight((current) => current === next ? current : next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined' || !measureRef.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(measureRef.current);
    return () => observer.disconnect();
  }, [name]);

  const visibleLines = naturalHeight > LINE_HEIGHT_PX + 0.5 ? 2 : 1;
  const overflowing = naturalHeight > TWO_LINE_HEIGHT_PX + 0.5;
  const looping = active && overflowing;
  const loopStyle = {
    '--group-name-loop-distance': `${naturalHeight}px`,
    '--group-name-loop-duration': `${naturalHeight / LOOP_SPEED_PX_PER_SECOND}s`,
  } as CSSProperties;

  return (
    <span
      className="group-name-display"
      data-testid="group-name-display"
      data-group-visible-lines={visibleLines}
    >
      {looping ? (
        <span className="group-name-viewport" data-testid="group-name-loop">
          <span className="group-name-loop-track" style={loopStyle}>
            <span className="group-name-loop-copy">{name}</span>
            <span className="group-name-loop-copy" aria-hidden="true">{name}</span>
          </span>
        </span>
      ) : (
        <span
          className="group-name-static"
          data-group-name-static
          data-testid="group-name-static"
        >
          <GroupTitleText name={name} generation={titleGeneration} />
        </span>
      )}
      <span
        ref={measureRef}
        className="group-name-measure"
        data-group-name-measure
        aria-hidden="true"
      >
        {name}
      </span>
    </span>
  );
}
