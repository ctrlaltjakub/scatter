import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AsciiAuraLayer } from './AsciiAuraLayer';
import { useSettingsStore } from '@/store/useSettingsStore';

const makeRef = () => ({ current: document.createElement('div') });

afterEach(() => {
  // Unmount FIRST. Otherwise flipping simulateWebglFailure back to false while
  // the (mocked-WebGL-available) component is still mounted would make the
  // chooser mount the real GL renderer, which throws on document.fonts in jsdom.
  cleanup();
  useSettingsStore.setState({ simulateWebglFailure: false });
  vi.restoreAllMocks();
});

describe('AsciiAuraLayer chooser', () => {
  it('shows the "unavailable" notice when WebGL2 is missing', async () => {
    // jsdom has no WebGL2 → getContext('webgl2') returns null → notice.
    render(<AsciiAuraLayer containerRef={makeRef()} />);
    expect(await screen.findByText('Canvas graphics unavailable')).toBeInTheDocument();
  });

  it('shows the notice when the dev simulate flag is on, even if WebGL2 works', async () => {
    // Pretend WebGL2 is available so the probe would normally pick the GL path…
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      { getExtension: () => null } as unknown as RenderingContext,
    );
    // …but the dev simulate flag must short-circuit straight to the notice.
    useSettingsStore.setState({ simulateWebglFailure: true });
    render(<AsciiAuraLayer containerRef={makeRef()} />);
    expect(await screen.findByText('Canvas graphics unavailable')).toBeInTheDocument();
  });
});
