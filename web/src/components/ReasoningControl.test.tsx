import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ReasoningControl } from './ReasoningControl';
import { SidebarModelPicker } from './SidebarModelPicker';
import { DEFAULT_SETTINGS } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { colorToCss } from '@/lib/groupColor';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => undefined), loadSettings: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useSettingsStore.setState({ ...DEFAULT_SETTINGS,
    providers: [{ id: 'p', preset: 'openrouter', apiKey: 'test', enabledModels: ['google/gemini-3.8-flash'] }],
    activeModelRef: { providerId: 'p', model: 'google/gemini-3.8-flash' },
  });
  useModelCatalogStore.getState().clear();
  useModelCatalogStore.getState().setCatalog('p', [{ id: 'google/gemini-3.8-flash', caps: { reasoning: true, vision: true, tools: true }, reasoning: { supportedEfforts: ['low', 'medium', 'high'], mandatory: true } }]);
  vi.spyOn(useModelCatalogStore.getState(), 'refreshCatalog').mockResolvedValue([]);
  const project = createBlankProject('Colors', 'root'); project.color = '#ed7296';
  useGraphStore.setState({ project });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useGraphStore.getState().setProject(null); });

describe('reasoning controls', () => {
  it('uses the project color, cleans the model name, and only changes main effort', () => {
    const { container } = render(<SidebarModelPicker />);
    expect(screen.getByText('gemini 3.8 flash')).toBeInTheDocument();
    expect((container.querySelector('.sc-reasoning-control') as HTMLElement).style.getPropertyValue('--reasoning-accent'))
      .toBe(colorToCss(useGraphStore.getState().project!.color!));
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }));
    const menu = screen.getByRole('dialog', { name: 'Main model reasoning' });
    expect(within(menu).getByText('Reasoning level:')).toBeInTheDocument();
    expect(within(menu).queryByText('gemini 3.8 flash')).not.toBeInTheDocument();
    expect(within(menu).queryByRole('button')).not.toBeInTheDocument();
    expect(menu.querySelector('svg')).toBeNull();
    expect(menu.parentElement).toBe(document.body);
    const range = screen.getByRole('slider', { name: 'Reasoning effort' });
    expect(range).toHaveAttribute('max', '2');
    fireEvent.change(range, { target: { value: '2' } });
    expect(useSettingsStore.getState().reasoningEffort).toBe('high');
    expect((container.querySelector('.sc-reasoning-needle') as SVGElement).style.getPropertyValue('--needle-angle')).toBe('45deg');
    expect(useSettingsStore.getState().interactiveReasoningEffort).toBe('high');
    fireEvent.change(range, { target: { value: '1' } });
    expect((container.querySelector('.sc-reasoning-needle') as SVGElement).style.getPropertyValue('--needle-angle')).toBe('0deg');
    expect(useSettingsStore.getState().interactiveReasoningEffort).toBe('high');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Main model reasoning' })).not.toBeInTheDocument();
  });
  it.each([
    ['off', -100], ['minimal', -75], ['low', -45], ['medium', 0],
    ['high', 45], ['xhigh', 75], ['max', 100],
  ] as const)('shows %s with a fixed needle position, without additional symbols', (value, angle) => {
    useModelCatalogStore.getState().setCatalog('p', [{ id: 'all-levels', reasoning: {
      supportedEfforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    } }]);
    const { container } = render(<ReasoningControl modelRef={{ providerId: 'p', model: 'all-levels' }} value={value} onChange={() => {}} />);
    const gauge = container.querySelector('svg')!;
    expect(gauge).toHaveAttribute('width', '16');
    expect(gauge.querySelectorAll('path')).toHaveLength(2);
    expect((gauge.querySelector('.sc-reasoning-needle') as SVGElement).style.getPropertyValue('--needle-angle')).toBe(`${angle}deg`);
  });
  it('shows the effective supported effort, not an unsupported saved choice', () => {
    const { container } = render(<ReasoningControl modelRef={{ providerId: 'p', model: 'google/gemini-3.8-flash' }} value="max" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Reasoning effort' })).toHaveAttribute('data-tip', 'Reasoning effort: High');
    expect((container.querySelector('.sc-reasoning-needle') as SVGElement).style.getPropertyValue('--needle-angle')).toBe('45deg');
  });
  it('adapts the slider to API metadata and disables an unsupported model', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ReasoningControl inline modelRef={{ providerId: 'p', model: 'google/gemini-3.8-flash' }} value="high" onChange={onChange} />);
    act(() => useModelCatalogStore.getState().setCatalog('p', [{ id: 'google/gemini-3.8-flash', reasoning: { supportedEfforts: ['low', 'high', 'max'] } }]));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith('max');
    rerender(<ReasoningControl modelRef={{ providerId: 'p', model: 'no-reasoning' }} value="high" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Reasoning effort' })).toBeDisabled();
  });
  it('shows binary local reasoning as Off and On, not invented effort levels', () => {
    useModelCatalogStore.getState().setCatalog('p', [{ id: 'binary', reasoning: { mode: 'toggle', supportedEfforts: ['off', 'high'] } }]);
    const change = vi.fn();
    render(<ReasoningControl inline modelRef={{ providerId: 'p', model: 'binary' }} value="high" onChange={change} />);
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'On');
    expect(screen.queryByText('High')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
    expect(change).toHaveBeenCalledWith('off');
  });

  it('closes the model list when opening reasoning and follows project color changes', () => {
    const { container } = render(<SidebarModelPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'gemini 3.8 flash' }));
    expect(container.querySelector('.sc-modelpicker-pop')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }));
    expect(container.querySelector('.sc-modelpicker-pop')).toBeNull();
    const project = { ...useGraphStore.getState().project!, color: '#40a080' };
    act(() => useGraphStore.setState({ project }));
    expect((container.querySelector('.sc-reasoning-control') as HTMLElement).style.getPropertyValue('--reasoning-accent'))
      .toBe(colorToCss(project.color));
    expect(screen.getByRole('dialog').style.getPropertyValue('--reasoning-accent')).toBe(colorToCss(project.color));
  });
  it('keeps clicks inside the detached menu from closing it or reaching the canvas', () => {
    const canvasDown = vi.fn();
    render(<div onPointerDown={canvasDown}><SidebarModelPicker /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }));
    fireEvent.pointerDown(screen.getByRole('slider'));
    expect(canvasDown).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('keeps a peeking sidebar open until its detached menu closes or unmounts', () => {
    const onOpen = vi.fn();
    const { unmount } = render(<SidebarModelPicker onReasoningOpenChange={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }));
    expect(onOpen).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpen).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }));
    unmount();
    expect(onOpen).toHaveBeenLastCalledWith(false);
  });
  it('sizes the sidebar menu to all supported labels without changing on selection', () => {
    render(<SidebarModelPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }));
    const menu = screen.getByRole('dialog');
    expect(menu.style.width).toBe('max-content');
    const reservedLabels = () => Array.from(menu.querySelectorAll('.sc-reasoning-size-label'))
      .map((element) => [element.textContent, element.getAttribute('aria-hidden')]);
    expect(reservedLabels()).toEqual([['Low', 'true'], ['Medium', 'true'], ['High', 'true']]);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
    expect(reservedLabels()).toEqual([['Low', 'true'], ['Medium', 'true'], ['High', 'true']]);
    expect(menu.style.width).toBe('max-content');
  });
  it('keeps the below-toolbar menu matched to its panel instead of content sizing', () => {
    render(<SidebarModelPicker placement="down" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }));
    const menu = screen.getByRole('dialog');
    expect(menu.style.width).not.toBe('max-content');
    expect(menu.querySelector('.sc-reasoning-size-label')).toBeNull();
  });
  it('opens below the topic-picker row inside its overlay, not behind the backdrop', () => {
    const { container } = render(<div className="welcome welcome--picker"><SidebarModelPicker placement="down" /></div>);
    const picker = container.querySelector('.sc-modelpicker')!;
    vi.spyOn(picker, 'getBoundingClientRect').mockReturnValue({ left: 700, right: 1000, top: 200, bottom: 232, width: 300 } as DOMRect);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }));
    const menu = screen.getByRole('dialog', { name: 'Main model reasoning' });
    expect(menu.parentElement).toBe(container.querySelector('.welcome--picker'));
    expect(menu.style.top).toBe('236px');
    expect(menu.style.left).toBe('700px');
    fireEvent.pointerDown(screen.getByRole('slider'));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
    expect(useSettingsStore.getState().reasoningEffort).toBe('high');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reasoning effort' })).toHaveFocus();
  });
});
