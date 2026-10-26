'use client';

import { useLayoutEffect, useRef } from 'react';

/** One continuous centerline, half a pixel inside every outer edge. */
export function welcomeTabShape(width: number, height: number, radius: number) {
  const r = radius - 0.5;
  const extension = radius - 1;
  const bottom = height - 0.5;
  const outline = `M${-extension} ${bottom}A${r} ${r} 0 0 0 .5 ${height - radius}`
    + `V${radius}A${r} ${r} 0 0 1 ${radius} .5H${width - radius}`
    + `A${r} ${r} 0 0 1 ${width - .5} ${radius}V${height - radius}`
    + `A${r} ${r} 0 0 0 ${width + extension} ${bottom}`;
  return { viewBox: `${-extension} 0 ${width + extension * 2} ${height}`,
    // Continue the opaque fill one pixel into the panel. A clipped fill ending
    // exactly on a fractional pixel would reveal a faint line underneath it.
    outline, fill: `${outline}V${height + 1}H${-extension}Z` };
}

export function WelcomeTabShape() {
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const svg = ref.current;
    const button = svg?.parentElement;
    if (!svg || !button) return;
    const fill = svg.querySelector('.welcome-start-tab-shape-fill')!;
    const stroke = svg.querySelector('.welcome-start-tab-shape-stroke')!;
    let previous = '';
    const update = (entry?: ResizeObserverEntry) => {
      // Layout dimensions stay correct under browser zoom and CSS transforms;
      // getBoundingClientRect would incorrectly include the transform scale.
      const style = getComputedStyle(button);
      const box = entry?.borderBoxSize?.[0];
      const width = box?.inlineSize ?? parseFloat(style.width);
      const height = box?.blockSize ?? parseFloat(style.height);
      const radius = parseFloat(style.getPropertyValue('--welcome-tab-radius'));
      if (![width, height, radius].every(Number.isFinite) || width <= 0 || height <= 0 || radius < 1) return;
      const key = `${width}:${height}:${radius}`;
      if (key === previous) return;
      previous = key;
      const shape = welcomeTabShape(width, height, radius);
      svg.setAttribute('viewBox', shape.viewBox);
      fill.setAttribute('d', shape.fill);
      stroke.setAttribute('d', shape.outline);
    };
    update();
    // Only these three attributes change during the tab's width animation;
    // no React state, parent rerender, or change to layout is needed.
    const observer = new ResizeObserver(entries => update(entries[0]));
    observer.observe(button, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);
  return <svg ref={ref} className="welcome-start-tab-shape" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <path className="welcome-start-tab-shape-fill" />
    <path className="welcome-start-tab-shape-stroke" strokeWidth="1" />
  </svg>;
}
