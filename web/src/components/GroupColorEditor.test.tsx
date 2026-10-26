/**
 * The group color panel is portaled to document.body (position:fixed,
 * following its anchor row) so the sidebar's scrolling groups list can't
 * clip it — with many groups it used to open below the fold and force the
 * user to scroll the list to reach it.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { GroupColorEditor } from './GroupColorEditor';

beforeAll(() => {
  // Async rAF stub — the panel's follow loop reschedules itself each frame.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;
});

afterEach(() => {
  cleanup();
});

/** Mimics the Sidebar flow: the row exists first, the panel opens later. */
function Harness({ onPick, open }: { onPick: (c: string) => void; open: boolean }) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} className="sidebar-row">
      {open && <GroupColorEditor current="mauve" onPick={onPick} anchorRef={rowRef} />}
    </div>
  );
}

describe('GroupColorEditor — floating panel', () => {
  it('renders into document.body (portal), positioned on the first frame', () => {
    const { rerender } = render(<Harness onPick={() => {}} open={false} />);
    rerender(<Harness onPick={() => {}} open />);
    const panel = document.querySelector('.group-color-editor') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.parentElement).toBe(document.body);
    // Positioned synchronously — no flash at (0,0) before the first rAF.
    expect(panel.style.left).not.toBe('');
    expect(panel.style.top).not.toBe('');
  });

  it('still delivers swatch clicks to onPick', () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} open />);
    const swatch = document.querySelector('.gc-swatch') as HTMLElement;
    fireEvent.click(swatch);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
