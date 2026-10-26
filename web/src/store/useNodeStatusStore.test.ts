import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNodeStatusStore } from './useNodeStatusStore';
import { layoutStatusProcesses } from '@/lib/asciiAura/statusText';

beforeEach(() => useNodeStatusStore.setState({ statuses: {}, processes: {} }));
afterEach(() => vi.restoreAllMocks());
it('updates fact-check counters in place without restarting the ASCII reveal', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  const store = useNodeStatusStore.getState();
  store.setProcessStatus('n', 'fact-check', 'CHECKING FACTS 0/12', false);
  clock.mockReturnValue(2000);
  store.setProcessStatus('n', 'fact-check', 'CHECKING FACTS 10/12', false);
  const entry = useNodeStatusStore.getState().processes.n!['fact-check']!;
  expect(entry.startedAt).toBe(100);
  const opts = { processes: [entry], node: { x: 100, y: 200, w: 600, h: 300 }, cellPx: 10, cols: 200, rows: 100 };
  expect(layoutStatusProcesses({ ...opts, now: 2000 })).toEqual(layoutStatusProcesses({ ...opts, now: 4400 }));
  store.clearProcessStatus('n', 'fact-check'); clock.mockReturnValue(5000);
  store.setProcessStatus('n', 'fact-check', 'CHECKING FACTS 0/12', false);
  expect(useNodeStatusStore.getState().processes.n!['fact-check']!.startedAt).toBe(5000);
});
it('keeps normal stage changes animated', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  useNodeStatusStore.getState().setProcessStatus('n', 'main', 'GENERATING');
  clock.mockReturnValue(400);
  useNodeStatusStore.getState().setProcessStatus('n', 'main', 'MARKING TERMS');
  expect(useNodeStatusStore.getState().processes.n!.main!.startedAt).toBe(400);
});
