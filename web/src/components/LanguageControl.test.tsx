import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageControl } from './LanguageControl';
import { useSettingsStore } from '@/store/useSettingsStore';
import { reasoningPopoverPosition } from '@/lib/reasoningPopover';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => {}), loadSettings: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  act(() => useSettingsStore.setState({ generationLanguage: 'en' }));
});
afterEach(() => vi.unstubAllGlobals());

describe('generation language picker', () => {
  it('shows all languages, fuzzy-filters native/English names, and saves a selection', () => {
    render(<LanguageControl />);
    expect(screen.getByRole('button', { name: 'Generation language: English' })
      .querySelector('.sc-language-trigger-label')).toHaveTextContent('EN');
    fireEvent.click(screen.getByRole('button', { name: 'Generation language: English' }));
    expect(screen.getAllByRole('option')).toHaveLength(20);
    const input = screen.getByRole('searchbox', { name: 'Search languages' });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'Polsh' } });
    expect(screen.getByRole('option', { name: /Polish/ })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useSettingsStore.getState().generationLanguage).toBe('pl');
    expect(screen.getByRole('button', { name: 'Generation language: Polish' })).toHaveTextContent('PL');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('renders inside the topic-picker overlay and restores trigger focus on Escape', () => {
    const { container } = render(<div className="welcome--picker"><LanguageControl placement="below" /></div>);
    const trigger = screen.getByRole('button', { name: 'Generation language: English' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog').parentElement).toBe(container.firstChild);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it('fades only overflowing edges, keeps the scrollbar opaque, and resets after filtering', () => {
    render(<LanguageControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Generation language: English' }));
    const list = screen.getByRole('listbox', { name: 'Languages' });
    let contentHeight = 900;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 240 },
      clientWidth: { configurable: true, value: 262 },
      offsetWidth: { configurable: true, value: 270 },
      scrollHeight: { configurable: true, get: () => contentHeight },
    });
    fireEvent.scroll(list);
    expect(list.style.getPropertyValue('--language-fade-top')).toBe('0px');
    expect(list.style.getPropertyValue('--language-fade-bottom')).toBe('24px');
    expect(list.style.getPropertyValue('--language-scrollbar-width')).toBe('8px');
    list.scrollTop = 12;
    fireEvent.scroll(list);
    expect(list.style.getPropertyValue('--language-fade-top')).toBe('12px');
    list.scrollTop = 660;
    fireEvent.scroll(list);
    expect(list.style.getPropertyValue('--language-fade-top')).toBe('24px');
    expect(list.style.getPropertyValue('--language-fade-bottom')).toBe('0px');
    contentHeight = 42;
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Polish' } });
    expect(list.scrollTop).toBe(0);
    expect(list.style.getPropertyValue('--language-fade-top')).toBe('0px');
    expect(list.style.getPropertyValue('--language-fade-bottom')).toBe('0px');
  });
  it('keeps the larger flyout inside a narrow viewport', () => {
    const panel = { left: 146, right: 386, top: 14, bottom: 154, width: 240 };
    const pos = reasoningPopoverPosition({ panel, picker: panel, below: true, viewportWidth: 390, viewportHeight: 500, height: 300, preferredWidth: 300 });
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + Number(pos.width)).toBeLessThanOrEqual(382);
    expect(pos.top + 300).toBeLessThanOrEqual(492);
  });
});
