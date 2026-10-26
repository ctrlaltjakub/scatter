import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelAssignments } from './ModelAssignments';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';

vi.mock('./MainModelLibrary', () => ({ MainModelLibrary: () => <p>Main catalog</p> }));
vi.mock('../SecondaryTaskModelPicker', () => ({ SecondaryTaskModelPicker: () => <p>Secondary catalog</p> }));
vi.mock('../InteractiveModelPicker', () => ({ InteractiveModelPicker: () => <p>Interactive catalog</p> }));
vi.mock('../ImageModelPicker', () => ({ ImageModelPicker: () => <p>Image catalog</p> }));

beforeEach(() => {
  useSettingsStore.setState({ ...DEFAULT_SETTINGS });
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps the new model heading in view during transitions, then stops following it', () => {
  render(<ModelAssignments />);
  fireEvent.click(screen.getByRole('button', { name: /^Main models/ }));
  act(() => vi.advanceTimersByTime(300));
  const secondary = screen.getByRole('button', { name: /^Secondary tasks/ });
  expect(secondary).toHaveAttribute('data-tip', 'Expand secondary tasks settings');
  const scroll = vi.fn();
  secondary.scrollIntoView = scroll;
  fireEvent.click(secondary);
  expect(secondary).toHaveAttribute('data-tip', 'Collapse secondary tasks settings');
  expect(scroll).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(64));
  expect(scroll.mock.calls.length).toBeGreaterThan(1);
  act(() => vi.advanceTimersByTime(300));
  act(() => vi.advanceTimersByTime(32));
  scroll.mockClear();
  act(() => vi.advanceTimersByTime(1000));
  expect(scroll).not.toHaveBeenCalled();
});
