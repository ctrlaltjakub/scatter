import { describe, expect, it, vi } from 'vitest';
import {
  ImageEditorViewportController,
  imageEditorSliderToZoom,
  imageEditorViewTransform,
  imageEditorZoomToSlider,
} from './imageEditorViewport';

const geometry = {
  viewportWidth: 800,
  viewportHeight: 600,
  region: { x: 0, y: 0, width: 800, height: 400 },
};

describe('ImageEditorViewportController', () => {
  it('starts fitted, clamps to 100–800%, and fits back to center', () => {
    const controller = new ImageEditorViewportController();
    controller.configure(geometry);
    controller.setZoom(99);
    expect(controller.getSnapshot().zoom).toBe(8);
    controller.panBy(100, 100);
    controller.fit();
    expect(controller.getSnapshot()).toMatchObject({ zoom: 1, panX: 0, panY: 0 });
    controller.setZoom(0.1);
    expect(controller.getSnapshot().zoom).toBe(1);
  });

  it('keeps the image point beneath the pointer fixed while zooming', () => {
    const controller = new ImageEditorViewportController();
    controller.configure(geometry);
    const anchor = { x: 620, y: 300 };
    const before = imageEditorViewTransform(controller.getSnapshot(), geometry);
    const worldBefore = (anchor.x - before.x) / before.scale;
    controller.setZoom(2, anchor);
    const after = imageEditorViewTransform(controller.getSnapshot(), geometry);
    const worldAfter = (anchor.x - after.x) / after.scale;
    expect(worldAfter).toBeCloseTo(worldBefore, 8);
  });

  it('clamps pan to visible image edges and removes unusable-axis pan', () => {
    const controller = new ImageEditorViewportController();
    controller.configure(geometry);
    controller.panBy(500, 500);
    expect(controller.getSnapshot()).toMatchObject({ panX: 0, panY: 0 });
    controller.setZoom(2);
    controller.panBy(9999, 9999);
    expect(controller.getSnapshot()).toMatchObject({ panX: 400, panY: 100 });
    controller.panBy(-9999, -9999);
    expect(controller.getSnapshot()).toMatchObject({ panX: -400, panY: -100 });
  });

  it('preserves zoom and reclamps pan when geometry changes', () => {
    const controller = new ImageEditorViewportController();
    controller.configure(geometry);
    controller.setZoom(3);
    controller.panBy(500, 200);
    controller.configure({ ...geometry, viewportWidth: 1200, viewportHeight: 900 });
    expect(controller.getSnapshot().zoom).toBe(3);
    expect(Math.abs(controller.getSnapshot().panX)).toBeLessThanOrEqual(1200);
  });

  it('normalizes logarithmic slider endpoints and round-trips zoom', () => {
    expect(imageEditorZoomToSlider(1)).toBe(0);
    expect(imageEditorZoomToSlider(8)).toBe(100);
    expect(imageEditorSliderToZoom(0)).toBe(1);
    expect(imageEditorSliderToZoom(100)).toBe(8);
    expect(imageEditorSliderToZoom(imageEditorZoomToSlider(3.25))).toBeCloseTo(3.25, 8);
  });

  it('notifies interaction state without changing image-view data', () => {
    const controller = new ImageEditorViewportController();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.setSpaceHeld(true);
    controller.setPanning(true);
    expect(controller.getSnapshot()).toMatchObject({
      zoom: 1, panX: 0, panY: 0, spaceHeld: true, panning: true,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies when geometry first arrives even if fitted camera values stay unchanged', () => {
    const controller = new ImageEditorViewportController();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.configure(geometry);
    expect(listener).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().revision).toBe(1);
  });
});
