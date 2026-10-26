import { beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnosticPlan, diagnosticSignature, runDiagnosticPlan, type DiagnosticJob, type DiagnosticResult } from '@/lib/modelDiagnostics';
import { DEFAULT_SETTINGS } from './types';
import { useSettingsStore } from './useSettingsStore';
import { useModelDiagnosticsStore } from './useModelDiagnosticsStore';

vi.mock('@/lib/modelDiagnostics', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/modelDiagnostics')>(), runDiagnosticPlan: vi.fn(),
}));

const runner = vi.mocked(runDiagnosticPlan);
let finish: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, providers: [{ id: 'local', preset: 'custom', apiKey: 'test-only', enabledModels: ['model'] }],
    activeModelRef: { providerId: 'local', model: 'model' }, secondaryUseSameModel: true, secondaryModelRef: undefined, interactiveModelRef: undefined, imageModelRef: null });
  useModelDiagnosticsStore.setState({ running: false, results: [], signature: undefined, error: undefined, timeoutSeconds: 180 });
  runner.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
});
const result = (job: DiagnosticJob, status: DiagnosticResult['status']): DiagnosticResult => ({
  key: job.key, role: job.target.role, model: job.target.model, provider: 'local', label: job.test.label, status, detail: 'Test result',
});

describe('model diagnostics session controls', () => {
  it('tests only the main model selected at the start of each run', async () => {
    const provider = useSettingsStore.getState().providers[0]!;
    useSettingsStore.setState({ providers: [{ ...provider, enabledModels: ['model', 'other-model'] }],
      activeModelRef: { providerId: provider.id, model: 'other-model' } });
    const firstRun = useModelDiagnosticsStore.getState().run('main');
    const [jobs, snapshot] = runner.mock.calls[0]!;
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every(job => job.target.model === 'other-model')).toBe(true);
    useSettingsStore.setState({ activeModelRef: { providerId: provider.id, model: 'model' } });
    expect(snapshot.activeModelRef?.model).toBe('other-model');
    expect(jobs.every(job => job.target.model === 'other-model')).toBe(true);
    finish(); await firstRun;
    const nextRun = useModelDiagnosticsStore.getState().run();
    const mainJobs = runner.mock.calls[1]![0].filter(job => job.target.role === 'main');
    expect(mainJobs).toHaveLength(jobs.length);
    expect(mainJobs.every(job => job.target.model === 'model')).toBe(true);
    finish(); await nextRun;
  });

  it('keeps result rows in plan order when parallel checks complete out of order', async () => {
    const pending = useModelDiagnosticsStore.getState().run('main');
    const [jobs, , options] = runner.mock.calls[0]!;
    options.onResult(result(jobs[0]!, 'running'));
    options.onResult(result(jobs[1]!, 'running'));
    options.onResult(result(jobs[1]!, 'passed'));
    options.onResult(result(jobs[0]!, 'failed'));
    expect(useModelDiagnosticsStore.getState().results.map(r => [r.key, r.status])).toEqual([
      [jobs[0]!.key, 'failed'], [jobs[1]!.key, 'passed'],
    ]);
    finish(); await pending;
    expect(useModelDiagnosticsStore.getState().running).toBe(false);
  });

  it('runs only the chosen check, preserves other results, and clamps timeout to 30 seconds', async () => {
    const cfg = useSettingsStore.getState(), jobs = diagnosticPlan(cfg, 'main').slice(0, 2);
    useModelDiagnosticsStore.setState({ signature: diagnosticSignature(cfg), results: jobs.map(job => result(job, 'passed')) });
    const pending = useModelDiagnosticsStore.getState().run('main', 1, jobs[0]!.key);
    const [selected, , options] = runner.mock.calls[0]!;
    expect(selected.map(job => job.key)).toEqual([jobs[0]!.key]);
    expect(options.timeoutMs).toBe(30_000);
    options.onResult(result(jobs[0]!, 'running'));
    expect(useModelDiagnosticsStore.getState().results.map(r => [r.key, r.status])).toEqual([
      [jobs[0]!.key, 'running'], [jobs[1]!.key, 'passed'],
    ]);
    finish(); await pending;
  });

  it('stops one request independently and uses the parent signal to stop the whole run', async () => {
    const pending = useModelDiagnosticsStore.getState().run('main');
    const [jobs, , options] = runner.mock.calls[0]!;
    const first = new AbortController(), second = new AbortController();
    options.onController!(jobs[0]!.key, first);
    options.onController!(jobs[1]!.key, second);
    useModelDiagnosticsStore.getState().stop(jobs[0]!.key);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(options.signal.aborted).toBe(false);
    useModelDiagnosticsStore.getState().stop();
    expect(options.signal.aborted).toBe(true);
    finish(); await pending;
    useModelDiagnosticsStore.getState().stop(jobs[1]!.key);
    expect(second.signal.aborted).toBe(false); // Completed sessions release handles.
  });

  it('does not clear or start duplicate runs while busy, then clears completed results', async () => {
    const pending = useModelDiagnosticsStore.getState().run('secondary');
    const [jobs, , options] = runner.mock.calls[0]!;
    options.onResult(result(jobs[0]!, 'passed'));
    await useModelDiagnosticsStore.getState().run('main');
    useModelDiagnosticsStore.getState().clear();
    expect(runner).toHaveBeenCalledOnce();
    expect(useModelDiagnosticsStore.getState().results).toHaveLength(1);
    finish(); await pending;
    useModelDiagnosticsStore.getState().clear();
    expect(useModelDiagnosticsStore.getState().results).toEqual([]);
    expect(useModelDiagnosticsStore.getState().signature).toBeUndefined();
  });

  it('keeps the chosen timeout across panel remounts and prevents changes during a run', async () => {
    useModelDiagnosticsStore.getState().setTimeoutSeconds(30);
    const pending = useModelDiagnosticsStore.getState().run('secondary');
    expect(runner.mock.calls[0]![2].timeoutMs).toBe(30_000);
    useModelDiagnosticsStore.getState().setTimeoutSeconds(900);
    expect(useModelDiagnosticsStore.getState().timeoutSeconds).toBe(30);
    finish(); await pending;
    useModelDiagnosticsStore.getState().clear();
    expect(useModelDiagnosticsStore.getState().timeoutSeconds).toBe(30);
  });
});
