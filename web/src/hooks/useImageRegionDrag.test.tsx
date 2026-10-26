import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRegion } from '@/store/types';
import { useImageRegionDrag } from './useImageRegionDrag';

const changed = vi.fn();
const started = vi.fn();
const clicked = vi.fn();
function Harness({ enabled = true }: { enabled?: boolean }) {
  const [regions, setRegions] = useState<ImageRegion[]>([]);
  const selection = useImageRegionDrag({ enabled, regions,
    bounds: () => ({ left: 100, top: 50, width: 200, height: 100 }),
    onStart: started,
    onClick: clicked,
    onChange: (next) => { changed(next); setRegions(next); },
  });
  return <div data-testid="surface" {...selection.handlers}><output>{JSON.stringify(selection.displayedRegions)}</output></div>;
}
beforeEach(() => {
  changed.mockClear();
  started.mockClear();
  clicked.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
});
function drag(modifiers = {}, from = [120, 60], to = [200, 100]) {
  const surface = screen.getByTestId('surface');
  fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: from[0], clientY: from[1], ...modifiers });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: to[0], clientY: to[1], ...modifiers });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: to[0], clientY: to[1], ...modifiers });
}
describe('image region drag', () => {
  it('supports ordinary/Shift drags, replaces normally and adds with Ctrl/Command', () => {
    render(<Harness />);
    drag();
    expect(changed).toHaveBeenLastCalledWith([{ x: .1, y: .1, width: .4, height: .4 }]);
    drag({ shiftKey: true });
    expect(changed.mock.lastCall?.[0]).toHaveLength(1);
    drag({ ctrlKey: true }, [200, 100], [250, 130]);
    expect(changed.mock.lastCall?.[0]).toHaveLength(2);
    drag({ metaKey: true }, [200, 100], [250, 130]);
    expect(changed.mock.lastCall?.[0]).toHaveLength(3);
  });
  it('commits once at release, clamps outside edges, and ignores letterbox margins', () => {
    render(<Harness />);
    const surface = screen.getByTestId('surface');
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 120, clientY: 60 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 999, clientY: 999 });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 999, clientY: 999 });
    expect(changed).toHaveBeenCalledExactlyOnceWith([{ x: .1, y: .1, width: .9, height: .9 }]);
    changed.mockClear();
    drag({}, [5, 5], [150, 90]);
    expect(changed).not.toHaveBeenCalled();
  });
  it('preserves the previous selection on cancel and clears with a plain click or Escape', () => {
    render(<Harness />);
    drag();
    const surface = screen.getByTestId('surface');
    fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 120, clientY: 60 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 280, clientY: 130 });
    fireEvent.pointerCancel(surface, { pointerId: 2 });
    expect(changed).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(changed).toHaveBeenLastCalledWith([]);
    drag();
    drag({}, [130, 70], [130, 70]);
    expect(changed).toHaveBeenLastCalledWith([]);
  });
  it('does not select while a different editor tool owns the pointer', () => {
    render(<Harness enabled={false} />);
    drag({ shiftKey: true });
    expect(changed).not.toHaveBeenCalled();
  });
  it('keeps ordinary and Ctrl clicks distinct from selection drags', () => {
    render(<Harness />);
    const surface = screen.getByTestId('surface');
    drag({ ctrlKey: true }, [130, 70], [130, 70]);
    fireEvent.click(surface, { ctrlKey: true });
    expect(started).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledOnce();
    drag({}, [130, 70], [130, 70]);
    fireEvent.click(surface);
    expect(started).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledTimes(2);
    drag({ ctrlKey: true });
    expect(started).toHaveBeenCalledOnce();
    fireEvent.click(surface, { ctrlKey: true });
    expect(clicked).toHaveBeenCalledTimes(2);
  });
});
