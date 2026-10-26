import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InteractiveExplanationView } from './InteractiveExplanationView';
import type { InteractiveExplanation } from '@/store/types';
import { buildInteractiveNode } from '@/lib/interactiveActions';
import { THEME_CHANGE_EVENT } from '@/lib/theme';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useInteractiveRuntimeStore } from '@/store/useInteractiveRuntimeStore';

vi.mock('@/lib/interactiveActions', () => ({ buildInteractiveNode: vi.fn() }));

const interactive: InteractiveExplanation = {
  html: '<!doctype html><html><head></head><body><button>Move</button></body></html>',
  request: 'Teach movement',
  providerId: 'p1',
  model: 'gpt-5.6-terra',
  viewportSize: 580,
};
const landscapeInteractive: InteractiveExplanation = {
  ...interactive,
  viewportSize: undefined,
  viewportWidth: 960,
  viewportHeight: 720,
};
const previousLandscapeInteractive: InteractiveExplanation = {
  ...interactive,
  viewportSize: undefined,
  viewportWidth: 764,
  viewportHeight: 480,
};

describe('InteractiveExplanationView', () => {
  beforeEach(() => {
    vi.mocked(buildInteractiveNode).mockReset();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    document.documentElement.dataset.theme = 'latte';
    useInteractiveViewerStore.getState().close();
    useLiveViewportStore.getState().clear();
    useInteractiveRuntimeStore.setState({ revisions: {} });
  });

  afterEach(() => vi.useRealTimers());

  it.each(['canvas', 'viewer'] as const)('routes sandbox pinch input only to the canvas camera (%s)', presentation => {
    const { container } = render(<InteractiveExplanationView nodeId="pinch" versionIndex={0}
      interactive={landscapeInteractive} active generating={false} presentation={presentation} />);
    const iframe = container.querySelector('iframe')!;
    const channel = iframe.srcdoc.match(/var channel="([^"]+)"/)![1];
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 200, width: 480, height: 360 } as DOMRect);
    const wheel = vi.fn(); container.addEventListener('wheel', wheel);
    const send = (payload: unknown, source: Window | null = iframe.contentWindow) => {
      const event = new MessageEvent('message', { data: { __scatterInteractive: channel, type: 'canvas-zoom', payload } });
      Object.defineProperty(event, 'source', { value: source });
      act(() => window.dispatchEvent(event));
    };
    const input = { clientX: 240, clientY: 120, deltaY: -30, deltaMode: 0, ctrlKey: true };
    send(input, window); // A different frame cannot control the camera.
    send({ ...input, deltaY: NaN });
    send({ ...input, ctrlKey: false });
    expect(wheel).not.toHaveBeenCalled();
    send(input);
    if (presentation === 'viewer') expect(wheel).not.toHaveBeenCalled();
    else expect(wheel.mock.calls[0]![0]).toMatchObject({ clientX: 220, clientY: 260, deltaY: -30, ctrlKey: true, bubbles: true });
  });

  it.each(['canvas', 'viewer'] as const)('keeps %s input active during Gecko focus transfer into the sandbox', (presentation) => {
    const { container } = render(
      <InteractiveExplanationView nodeId="focus-transfer" versionIndex={0} interactive={landscapeInteractive} active generating={false} presentation={presentation}/>,
    );
    const iframe = container.querySelector('iframe')!;
    const wrapper = iframe.parentElement!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    vi.useFakeTimers();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('blur')));
    expect(wrapper).not.toHaveClass('is-paused');
    // Gecko finishes focusing the child without sending focus to the parent.
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => vi.runAllTimers());
    expect(wrapper).not.toHaveClass('is-paused');
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'host-state', payload: expect.objectContaining({ active: false }),
    }), '*');
  });

  it('still pauses on real window focus loss and resumes when the window returns', () => {
    const { container } = render(
      <InteractiveExplanationView nodeId="window-focus" versionIndex={0} interactive={landscapeInteractive} active generating={false}/>,
    );
    const iframe = container.querySelector('iframe')!;
    vi.useFakeTimers();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('blur')));
    act(() => vi.runAllTimers());
    expect(iframe.parentElement).toHaveClass('is-paused');
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(iframe.parentElement).not.toHaveClass('is-paused');
    expect(container.querySelector('iframe')).toBe(iframe);
  });

  it('pauses hidden tabs immediately and cancels stale deferred focus checks', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    try {
      const { container, unmount } = render(
        <InteractiveExplanationView nodeId="visibility" versionIndex={0} interactive={landscapeInteractive} active generating={false}/>,
      );
      const wrapper = container.querySelector('.sc-interactive-frame-wrap')!;
      vi.useFakeTimers();
      const schedule = vi.spyOn(window, 'setTimeout');
      const cancel = vi.spyOn(window, 'clearTimeout');
      act(() => window.dispatchEvent(new Event('blur')));
      const hiddenCheck = schedule.mock.results.at(-1)!.value;
      visibility.mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(wrapper).toHaveClass('is-paused');
      expect(cancel).toHaveBeenCalledWith(hiddenCheck);
      visibility.mockReturnValue('visible');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(wrapper).not.toHaveClass('is-paused');
      act(() => window.dispatchEvent(new Event('blur')));
      const refocusCheck = schedule.mock.results.at(-1)!.value;
      act(() => window.dispatchEvent(new Event('focus')));
      expect(cancel).toHaveBeenCalledWith(refocusCheck);
      act(() => window.dispatchEvent(new Event('blur')));
      const unmountCheck = schedule.mock.results.at(-1)!.value;
      unmount();
      expect(cancel).toHaveBeenCalledWith(unmountCheck);
    } finally {
      visibility.mockRestore();
    }
  });

  it('runs dedicated canvas programs only when focused and readable, without remounting on focus changes', async () => {
    const view=render(<InteractiveExplanationView nodeId="inline" versionIndex={0} interactive={landscapeInteractive} active generating={false} presentation="canvas"/>);
    await waitFor(()=>expect(view.container.querySelector('iframe')).not.toBeNull());
    const iframe=view.container.querySelector('iframe')!;
    expect(iframe.parentElement).not.toHaveClass('is-paused');
    expect(iframe.parentElement).not.toHaveClass('is-unfocused');
    view.rerender(<InteractiveExplanationView nodeId="inline" versionIndex={0} interactive={landscapeInteractive} active={false} generating={false} presentation="canvas"/>);
    expect(iframe.parentElement).toHaveClass('is-paused');
    expect(iframe.parentElement).toHaveClass('is-unfocused');
    expect(view.container.querySelector('iframe')).toBe(iframe);
    view.rerender(<InteractiveExplanationView nodeId="inline" versionIndex={0} interactive={landscapeInteractive} active generating={false} presentation="canvas"/>);
    expect(iframe.parentElement).not.toHaveClass('is-unfocused');
    act(()=>useLiveViewportStore.getState().setZoom(0.1));
    expect(iframe.parentElement).toHaveClass('is-paused');
    act(()=>useLiveViewportStore.getState().setZoom(1));
    expect(iframe.parentElement).not.toHaveClass('is-paused');
    act(()=>useInteractiveViewerStore.getState().openViewer('other',0));
    expect(iframe.parentElement).toHaveClass('is-paused');
  });

  it('restarts by replacing the sandbox without making a model call',async()=>{
    const view=render(<InteractiveExplanationView nodeId="restart" versionIndex={0} interactive={landscapeInteractive} active generating={false} presentation="canvas"/>);
    await waitFor(()=>expect(view.container.querySelector('iframe')).not.toBeNull());
    const original=view.container.querySelector('iframe');
    act(()=>useInteractiveRuntimeStore.getState().restart('restart'));
    expect(view.container.querySelector('iframe')).not.toBe(original);
    expect(buildInteractiveNode).not.toHaveBeenCalled();
  });

  it('fits legacy documents into the 4:3 preview without stretching', async () => {
    const view = render(
      <InteractiveExplanationView
        nodeId="n1" versionIndex={0} interactive={interactive} active generating={false}
      />,
    );
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
    let iframe = view.container.querySelector('iframe')!;
    expect(iframe.closest('.sc-interactive-frame-wrap'))
      .toHaveAttribute('data-source-viewport', '580x580');
    expect(iframe.style.width).toBe('580px');
    expect(iframe.style.height).toBe('580px');
    expect(iframe.style.left).toBe('50%');
    expect(iframe.style.top).toBe('50%');
    expect(iframe.style.transform).toMatch(/^translate\(-50%, -50%\) scale\(/);

    view.rerender(
      <InteractiveExplanationView
        nodeId="n1" versionIndex={1} interactive={previousLandscapeInteractive} active generating={false}
      />,
    );
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
    iframe = view.container.querySelector('iframe')!;
    expect(iframe.closest('.sc-interactive-frame-wrap'))
      .toHaveAttribute('data-source-viewport', '764x480');
    expect(iframe.style.width).toBe('764px');
    expect(iframe.style.height).toBe('480px');
    expect(iframe.closest('.sc-interactive-frame-wrap')).toHaveStyle({ width: '608px', height: '382px' });

    view.rerender(
      <InteractiveExplanationView
        nodeId="n1" versionIndex={2} interactive={landscapeInteractive} active generating={false}
      />,
    );
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
    iframe = view.container.querySelector('iframe')!;
    expect(iframe.closest('.sc-interactive-frame-wrap'))
      .toHaveAttribute('data-source-viewport', '960x720');
    expect(iframe.style.width).toBe('960px');
    expect(iframe.style.height).toBe('720px');
    expect(iframe.style.transform).toMatch(/^translate\(-50%, -50%\) scale\(/);
  });

  it('activates only the full-window viewer and fills its native 960 by 720 surface', async () => {
    const { container } = render(
      <InteractiveExplanationView
        nodeId="n1"
        versionIndex={0}
        interactive={landscapeInteractive}
        active
        generating={false}
        presentation="viewer"
      />,
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe')!;
    expect(iframe.closest('.sc-interactive-frame-wrap')).not.toHaveClass('is-paused');
    expect(iframe.closest('.sc-interactive-frame-wrap')).toHaveClass('sc-interactive-frame-wrap--viewer');
    expect(iframe).toHaveAttribute('allow', 'autoplay');
    expect(iframe.style.transform).toBe('translate(-50%, -50%) scale(1)');
  });

  it('closes the viewer when Escape comes from the focused sandbox', async () => {
    useInteractiveViewerStore.getState().openViewer('n1', 0);
    const { container } = render(
      <InteractiveExplanationView
        nodeId="n1"
        versionIndex={0}
        interactive={landscapeInteractive}
        active
        generating={false}
        presentation="viewer"
      />,
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe')!;
    const channel = iframe.getAttribute('srcdoc')?.match(/var channel="([^"]+)"/)?.[1];
    const event = new MessageEvent('message', {
      data: { __scatterInteractive: channel, type: 'escape' },
    });
    Object.defineProperty(event, 'source', { value: iframe.contentWindow });

    act(() => window.dispatchEvent(event));

    expect(useInteractiveViewerStore.getState().open).toBe(false);
  });

  it.each([false, true])('shows runtime errors and repairs from the correct saved version (unverified draft: %s)', async unverifiedDraft => {
    const { container } = render(
      <InteractiveExplanationView
        nodeId="n1" versionIndex={2} interactive={interactive} active generating={false} unverifiedDraft={unverifiedDraft}
      />,
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe')!;
    const srcDoc = iframe.getAttribute('srcdoc')!;
    const channel = srcDoc.match(/var channel="([^"]+)"/)?.[1];
    expect(channel).toBeTruthy();
    const payload = {
      message: 'Audio node is undefined',
      source: 'about:srcdoc',
      line: 12,
      column: 4,
      stack: 'exact stack',
    };
    const event = new MessageEvent('message', {
      data: { __scatterInteractive: channel, type: 'error', payload },
    });
    Object.defineProperty(event, 'source', { value: iframe.contentWindow });
    act(() => window.dispatchEvent(event));
    expect(buildInteractiveNode).not.toHaveBeenCalled();
    if (unverifiedDraft) {
      expect(container.querySelector('iframe')).toBe(iframe);
      expect(screen.queryByRole('alert')).toBeNull();
      return;
    }
    expect(screen.getByRole('alert')).toHaveTextContent(payload.message);
    fireEvent.click(screen.getByRole('button', { name: 'Repair' }));
    expect(buildInteractiveNode).toHaveBeenCalledWith('n1', unverifiedDraft ? payload.message : expect.stringContaining(payload.message), unverifiedDraft ? 'repair' : 'modify');
  });

  it('injects the node accent and sends live app-theme changes to the sandbox', async () => {
    const { container } = render(
      <InteractiveExplanationView
        nodeId="n1" versionIndex={0} interactive={interactive} active generating={false} accent="#123456"
      />,
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('srcdoc')).toContain('"primary":"#123456"');
    expect(iframe.getAttribute('srcdoc')).toContain('"primarySoft":"rgba(18,52,86,0.18)"');
    expect(iframe.getAttribute('srcdoc')).toContain('"onPrimary":"#ffffff"');
    expect(iframe.getAttribute('srcdoc')).toContain('--sc-primary-text');
    expect(iframe.getAttribute('srcdoc')).toContain('"fontSizeTitle":"18px"');
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    document.documentElement.dataset.theme = 'mocha';
    act(() => window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, {
      detail: { preference: 'dark', resolved: 'dark' },
    })));
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'host-state',
        payload: expect.objectContaining({
          theme: expect.objectContaining({ mode: 'dark', primary: '#123456' }),
        }),
      }),
      '*',
    ));
  });

  it('keeps the exact landscape well occupied while the program is generating', () => {
    const { container } = render(
      <InteractiveExplanationView
        nodeId="n1" versionIndex={0} active generating interactive={undefined}
      />,
    );
    expect(screen.getByLabelText('Loading interactive program')).toBeTruthy();
    expect(container.querySelector('.sc-interactive-generation-skeleton')).not.toBeNull();
    expect(container.querySelector('.lucide-square-mouse-pointer')).toHaveAttribute('width', '56');
  });
});
