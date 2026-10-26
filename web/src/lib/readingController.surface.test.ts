import { afterEach, describe, expect, it } from 'vitest';
import { readingSurfaceFor } from './readingController';

afterEach(() => {
  document.body.replaceChildren();
});

describe('readingSurfaceFor', () => {
  it('prefers the screen-sized interactive viewer over the hidden canvas card', () => {
    const canvas = document.createElement('div');
    canvas.dataset.nodeId = 'n1';
    canvas.className = 'node';
    const viewer = document.createElement('article');
    viewer.dataset.nodeId = 'n1';
    viewer.dataset.scReadingNodeId = 'n1';
    viewer.dataset.scReadingScale = '1';
    document.body.append(canvas, viewer);

    expect(readingSurfaceFor('n1')).toBe(viewer);
    expect(readingSurfaceFor('n1')?.dataset.scReadingScale).toBe('1');
  });

  it('falls back to the canvas card after the viewer closes', () => {
    const canvas = document.createElement('div');
    canvas.dataset.nodeId = 'n1';
    document.body.append(canvas);
    expect(readingSurfaceFor('n1')).toBe(canvas);
  });
});
