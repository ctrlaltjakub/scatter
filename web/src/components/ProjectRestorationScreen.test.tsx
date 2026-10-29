import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRestorationScreen } from './ProjectRestorationScreen';
import { hexToRgb } from '@/lib/groupColor';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useSyncStore } from '@/store/useSyncStore';
import { defaultSyncConfig } from '@/sync/local';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import type { AuraScene, AuraSceneFactory } from '@/lib/asciiAura/sceneState';

const auraLayerMock = vi.hoisted(() => vi.fn());

vi.mock('./canvas/AsciiAuraLayer', () => ({
  AsciiAuraLayer: (props: unknown) => {
    auraLayerMock(props);
    return <div data-testid="restoration-aura" />;
  },
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

describe('ProjectRestorationScreen', () => {
  beforeEach(() => {
    auraLayerMock.mockReset();
    localStorage.removeItem('scatter-decorative-motion');
    useSettingsStore.setState({ groupColorAssignment: 'opposites', providers: [], activeModelRef: null, reasoningEffort: 'low' });
    useSyncStore.setState({ config: defaultSyncConfig() });
    document.documentElement.dataset.theme = 'latte';
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  afterEach(() => {
    localStorage.removeItem('scatter-decorative-motion');
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders an inert sidebar with one project and one group skeleton', async () => {
    const { container } = render(<ProjectRestorationScreen />);
    await screen.findByLabelText('Restoring project');

    const shell = screen.getByLabelText('Restoring project');
    const sidebar = container.querySelector('.project-restoration-sidebar')!;
    const rows = sidebar.querySelectorAll('.project-restoration-row');
    expect(shell).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/restoring project/i)).not.toBeInTheDocument();
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Groups')).toBeInTheDocument();
    expect(screen.queryByText('75%')).not.toBeInTheDocument();
    expect(sidebar.querySelector('.zoom-readout')).toBeNull();
    expect(sidebar.querySelector('.lucide-sun')).not.toBeNull();
    expect(sidebar.querySelector('.lucide-settings')).not.toBeNull();
    expect(sidebar.querySelector('.sidebar-control-panel')).not.toBeNull();
    expect(sidebar.querySelector('.project-restoration-modelpicker')).not.toBeNull();
    expect(sidebar.querySelector('.sc-language-trigger > .sc-language-trigger-label')).not.toBeNull();
    expect(sidebar.querySelector('.lucide-globe')).not.toBeNull();
    expect(sidebar.querySelector('.lucide-gauge')).not.toBeNull();
    expect(sidebar.querySelector('.project-restoration-modelpicker + .source-controls + .project-restoration-footer'))
      .not.toBeNull();
    expect(sidebar.querySelector('button')).toBeNull();
    expect((rows[0] as HTMLElement).style.getPropertyValue('--row-accent')).toMatch(/^#[0-9a-f]{6}$/i);
    expect((rows[1] as HTMLElement).style.getPropertyValue('--row-accent')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(screen.getByTestId('restoration-aura')).toBeInTheDocument();
    expect(auraLayerMock).toHaveBeenCalledWith(expect.objectContaining({
      renderAppOverlays: false,
    }));
  });

  it('mirrors the dark navigation icon while remaining inert', async () => {
    document.documentElement.dataset.theme = 'mocha';
    const { container } = render(<ProjectRestorationScreen />);
    await screen.findByLabelText('Restoring project');

    const sidebar = container.querySelector('.project-restoration-sidebar')!;
    expect(sidebar.querySelector('.lucide-moon')).not.toBeNull();
    expect(sidebar.querySelector('.lucide-sun')).toBeNull();
    expect(sidebar.querySelectorAll('.project-restoration-footer .project-restoration-control'))
      .toHaveLength(7);
    expect(sidebar.querySelector('button')).toBeNull();
  });

  it('mirrors the effective reasoning needle without fetching a catalog or adding controls', () => {
    useSettingsStore.setState({ providers: [{ id: 'gauge-test', preset: 'openrouter', apiKey: '', enabledModels: ['reasoning'] }],
      activeModelRef: { providerId: 'gauge-test', model: 'reasoning' }, reasoningEffort: 'max' });
    useModelCatalogStore.getState().setCatalog('gauge-test', [{ id: 'reasoning', reasoning: { supportedEfforts: ['low', 'medium', 'high'] } }]);
    const { container } = render(<ProjectRestorationScreen />);
    const needle = container.querySelector('.sc-reasoning-needle') as SVGElement;
    expect(needle.style.getPropertyValue('--needle-angle')).toBe('45deg');
    act(() => useSettingsStore.setState({ reasoningEffort: 'low' }));
    expect(needle.style.getPropertyValue('--needle-angle')).toBe('-45deg');
    expect(container.querySelector('.project-restoration-modelpicker button')).toBeNull();
  });

  it('mirrors the always-visible sync icon, red only when not connected', () => {
    const { container } = render(<ProjectRestorationScreen />);
    const sync = container.querySelector('.sidebar-sync-button')!;
    expect(sync).toHaveClass('failed');
    expect(sync.querySelector('.lucide-cloud-sync')).not.toBeNull();
    expect(container.querySelectorAll('.sidebar-sync-button')).toHaveLength(1);
    act(() => useSyncStore.setState({ config: { ...defaultSyncConfig(), provider: 'google-drive', enabled: false } }));
    expect(sync).not.toHaveClass('failed');
    expect(container.querySelector('.project-restoration-sidebar button')).toBeNull();
  });

  it('changes to a reloadable, non-busy error without exposing app actions', async () => {
    const { container } = render(<ProjectRestorationScreen error={new Error('OPFS unavailable')} />);
    await screen.findByText("COULDN'T RESTORE PROJECTS");

    expect(screen.getByLabelText('Project restoration failed')).not.toHaveAttribute('aria-busy');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(container.querySelector('.project-restoration-sidebar button')).toBeNull();
  });

  it('updates both skeleton colors and reshuffles the wordmark at the 2.5-second crossing', () => {
    vi.useFakeTimers();
    const { container } = render(<ProjectRestorationScreen />);
    screen.getByLabelText('Restoring project');
    const rows = [...container.querySelectorAll<HTMLElement>('.project-restoration-row')];
    const before = rows.map((row) => row.style.getPropertyValue('--row-accent'));

    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    act(() => { vi.advanceTimersByTime(2_500); });

    const after = rows.map((row) => row.style.getPropertyValue('--row-accent'));
    const letterColors = [...container.querySelectorAll<HTMLElement>('.app-wordmark-letter')]
      .map((letter) => letter.style.color);
    const expectedLetterColors = after.map((hex) => {
      const [r, g, b] = hexToRgb(hex)!;
      return `rgb(${r}, ${g}, ${b})`;
    });
    expect(after).not.toEqual(before);
    expect(new Set(letterColors)).toEqual(new Set(expectedLetterColors));
  });

  it('clears its color timer and orbit frame on unmount', async () => {
    const clearTimeout = vi.spyOn(window, 'clearTimeout');
    const cancelFrame = vi.mocked(cancelAnimationFrame);
    const { unmount } = render(<ProjectRestorationScreen />);
    await act(async () => undefined);
    unmount();
    expect(clearTimeout).toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalled();
  });

  it('reports completion only after one full five-second orbit', () => {
    vi.useFakeTimers();
    const onMinimumCycleComplete = vi.fn();
    render(<ProjectRestorationScreen onMinimumCycleComplete={onMinimumCycleComplete} />);

    act(() => { vi.advanceTimersByTime(4_999); });
    expect(onMinimumCycleComplete).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onMinimumCycleComplete).toHaveBeenCalledTimes(1);
  });

  it('follows live system reduced motion and ignores the removed device override', () => {
    localStorage.setItem('scatter-decorative-motion', 'animate');
    const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.mocked(matchMedia).mockReturnValue(media as unknown as MediaQueryList);
    let scene!: AuraScene;
    auraLayerMock.mockImplementation((props: { sceneFactory: AuraSceneFactory }) => {
      scene = props.sceneFactory({ onDirty: vi.fn() });
    });
    const { unmount } = render(<ProjectRestorationScreen />);
    // The original startup effect reads the system preference after mounting;
    // any frame scheduled before that read must be cancelled.
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    const onChange = media.addEventListener.mock.calls[0]![1];
    act(() => { media.matches = false; onChange(); });
    const before = [...scene.state.auras.values()].map(aura => ({ ...aura.rect }));
    const frame = vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0];
    act(() => frame(performance.now() + 1250));
    const after = [...scene.state.auras.values()].map(aura => ({ ...aura.rect }));
    expect(after).not.toEqual(before);
    vi.mocked(requestAnimationFrame).mockClear();
    act(() => { media.matches = true; onChange(); });
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    unmount();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', onChange);
  });
});
