import { beforeEach, describe, expect, it } from 'vitest';
import { useLiveViewportStore } from './useLiveViewportStore';

describe('live viewport zoom limits', () => {
  beforeEach(() => useLiveViewportStore.getState().clear());

  it('caps direct viewport updates at 150%', () => {
    useLiveViewportStore.getState().setViewport({ x: 4, y: 5, zoom: 2 });
    expect(useLiveViewportStore.getState()).toMatchObject({ x: 4, y: 5, zoom: 1.5 });
  });

  it('caps zoom-only updates at 150%', () => {
    useLiveViewportStore.getState().setZoom(2);
    expect(useLiveViewportStore.getState().zoom).toBe(1.5);
  });

  it('caps a restored legacy viewport at 150%', () => {
    useLiveViewportStore.getState().setZoom(0.5);
    useLiveViewportStore.getState().seedFrom({ x: 12, y: 18, zoom: 3 });
    expect(useLiveViewportStore.getState()).toMatchObject({ x: 12, y: 18, zoom: 1.5 });
  });
});
