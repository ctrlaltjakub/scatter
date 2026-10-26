import { describe, expect, it } from 'vitest';
import { reasoningPopoverPosition } from './reasoningPopover';

const sidebar = { left: 0, right: 240, top: 0, bottom: 720, width: 240 };
const picker = { left: 0, right: 239, top: 606, bottom: 649, width: 239 };
const viewport = { viewportWidth: 1280, viewportHeight: 720, height: 70 };

describe('reasoning flyout placement', () => {
  it('sits outside the expanded sidebar and aligns to the model row top', () => {
    expect(reasoningPopoverPosition({ ...viewport, panel: sidebar, picker, below: false }))
      .toEqual({ left: 244, top: 606, width: 'max-content', maxWidth: 1028 });
  });
  it('matches the full corner panel width and stays below its sources row', () => {
    const corner = { left: 1026, right: 1266, top: 14, bottom: 154, width: 240 };
    const row = { ...corner, top: 54, bottom: 97 };
    expect(reasoningPopoverPosition({ ...viewport, panel: corner, picker: row, below: true }))
      .toEqual({ left: 1026, top: 158, width: 240, maxWidth: 240 });
  });
  it('shrinks into the available right-hand space on narrow screens', () => {
    expect(reasoningPopoverPosition({ ...viewport, viewportWidth: 390, panel: sidebar, picker, below: false }))
      .toEqual({ left: 244, top: 606, width: 'max-content', maxWidth: 138 });
  });
  it('keeps the complete menu above the bottom edge on short screens', () => {
    const pos = reasoningPopoverPosition({ ...viewport, viewportHeight: 660, panel: sidebar, picker, below: false });
    expect(pos.top + viewport.height).toBe(652);
    expect(pos.left).toBeGreaterThan(sidebar.right);
  });
});
