import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useModelDiagnosticsStore } from '@/store/useModelDiagnosticsStore';
import { diagnosticPlan, diagnosticSignature, type DiagnosticResult } from '@/lib/modelDiagnostics';
import { ModelDiagnostics } from './ModelDiagnostics';
import { LocalModelGuide } from './LocalModelGuide';

const run = vi.fn(), stop = vi.fn(), clear = vi.fn(), writeText = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  useModelCatalogStore.getState().clear();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, providers: [{ id: 'local', preset: 'custom', apiKey: 'test', enabledModels: ['model'] }], activeModelRef: { providerId: 'local', model: 'model' } });
  useModelDiagnosticsStore.setState({ running: false, results: [], signature: undefined, startedAt: undefined, error: undefined, timeoutSeconds: 180, run, stop, clear });
});
function sampleResult(role: DiagnosticResult['role'], status: DiagnosticResult['status'], index = 0): DiagnosticResult {
  const job = diagnosticPlan(useSettingsStore.getState(), role)[index]!;
  return { key: job.key, role, model: job.target.model, provider: 'local', label: job.test.label, status, detail: 'Test result details.', milliseconds: status === 'running' ? undefined : 1500 };
}
describe('optional model diagnostics UI', () => {
  it('shows the effective main-model reasoning and updates when server metadata arrives', () => {
    useSettingsStore.setState({ reasoningEffort: 'high' });
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    expect(screen.getByText(/Reasoning: Server default/)).toBeInTheDocument();
    act(() => useModelCatalogStore.getState().setCatalog('local', [{ id: 'model',
      reasoning: { supportedEfforts: ['low', 'medium', 'high'] } }]));
    expect(screen.getByText(/Reasoning: High/)).toBeInTheDocument();
    act(() => useSettingsStore.setState({ reasoningEffort: 'low' }));
    expect(screen.getByText(/Reasoning: Low/)).toBeInTheDocument();
  });

  it('names the active main model and updates the single-model checklist when selection changes', () => {
    useSettingsStore.setState({ providers: [
      { id: 'first', preset: 'openai', apiKey: 'test', enabledModels: ['first-model'] },
      { id: 'second', preset: 'custom', name: 'My local server', apiKey: 'test', enabledModels: ['other-model', 'active-model'] },
    ], activeModelRef: { providerId: 'second', model: 'active-model' } });
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    const role = screen.getByRole('region', { name: 'Main model tests' });
    expect(within(role).getByText('Test the currently selected main model: My local server — active model')).toBeInTheDocument();
    fireEvent.click(within(role).getByRole('button', { name: 'Individual checks for Main model' }));
    const count = diagnosticPlan(useSettingsStore.getState(), 'main').length;
    expect(within(role).getAllByRole('listitem')).toHaveLength(count);
    expect(within(role).getAllByRole('button', { name: 'Run Encyclopedic generation / regeneration' })).toHaveLength(1);
    act(() => useSettingsStore.setState({ activeModelRef: { providerId: 'first', model: 'first-model' } }));
    expect(within(role).getByText('Test the currently selected main model: OpenAI — first model')).toBeInTheDocument();
    expect(within(role).queryByText(/My local server — active model/)).not.toBeInTheDocument();
    expect(within(role).getAllByRole('listitem')).toHaveLength(count);
    expect(run).not.toHaveBeenCalled();
    act(() => useSettingsStore.setState({ activeModelRef: null }));
    expect(within(role).getByText('No main model selected')).toBeInTheDocument();
    expect(within(role).getByRole('button', { name: 'Test role' })).toBeDisabled();
  });

  it('starts collapsed and never automatically launches tests', () => {
    render(<ModelDiagnostics />);
    expect(screen.getByRole('button', { name: 'Test model capabilities' })).toHaveAttribute('aria-expanded', 'false');
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test model capabilities' }));
    expect(screen.getByText('Checks run in parallel, once each.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test all roles' }));
    expect(run).toHaveBeenCalledWith(undefined, 180, undefined);
    expect(screen.getByRole('button', { name: 'Individual checks for Main model' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Stop all tests' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear results' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy results as Markdown' })).toBeDisabled();
  });
  it('runs a single role, offers cancellation, and shows failure remedies', () => {
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    fireEvent.click(within(screen.getByRole('region', { name: 'Secondary tasks tests' })).getByRole('button', { name: 'Test role' }));
    expect(run).toHaveBeenCalledWith('secondary', 180, undefined);
    expect(screen.getByRole('button', { name: 'Individual checks for Secondary tasks' })).toHaveAttribute('aria-expanded', 'true');
    act(() => useModelDiagnosticsStore.setState({ running: true, results: [{ ...sampleResult('secondary', 'failed'), detail: 'Output limit reached. Increase it in Models and generation.', code: 'output_limit' }] }));
    expect(screen.getByRole('button', { name: 'Test all roles' })).toBeDisabled();
    const role = screen.getByRole('region', { name: 'Secondary tasks tests' });
    const details = role.querySelector('details')!;
    fireEvent.click(details.querySelector('summary')!);
    expect(within(role).getByText('Output limit reached. Increase it in Models and generation.')).toBeVisible();
    expect(within(role).getByText('output_limit')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Test results' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop all tests' }));
    expect(stop).toHaveBeenCalledWith();
  });
  it('offers a 30-second minimum timeout and starts only the chosen check within its role', () => {
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    const timeout = screen.getByRole('combobox', { name: 'Timeout per check' });
    expect([...timeout.querySelectorAll('option')].map(option => Number(option.value))).toEqual([30, 60, 180, 600, 900]);
    fireEvent.change(timeout, { target: { value: '30' } });
    const role = screen.getByRole('region', { name: 'Main model tests' });
    fireEvent.click(within(role).getByRole('button', { name: 'Individual checks for Main model' }));
    const job = diagnosticPlan(useSettingsStore.getState(), 'main')[0]!;
    fireEvent.click(within(role).getByRole('button', { name: `Run ${job.test.label}` }));
    expect(run).toHaveBeenCalledWith('main', 30, job.key);
  });
  it('shows progress and completed results in the same checklist and stops one check or all tests', () => {
    const jobs = diagnosticPlan(useSettingsStore.getState(), 'main').slice(0, 2);
    useModelDiagnosticsStore.setState({ running: true, results: jobs.map((job, index) => ({ key: job.key, role: 'main', model: 'model', provider: 'local', label: job.test.label, status: index === 0 ? 'running' : 'passed', detail: 'A test result.' })) });
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    const role = screen.getByRole('region', { name: 'Main model tests' });
    fireEvent.click(within(role).getByRole('button', { name: 'Individual checks for Main model' }));
    fireEvent.click(within(role).getByRole('button', { name: `Stop ${jobs[0]!.test.label}` }));
    expect(stop).toHaveBeenLastCalledWith(jobs[0]!.key);
    expect(within(role).getByRole('button', { name: `Run ${jobs[1]!.test.label}` })).toBeDisabled();
    const checks = within(role).getByRole('list', { name: 'Main model checks and results' });
    expect(checks.querySelector('[data-status="running"] > .is-spinning')).toBeInTheDocument();
    expect(checks.querySelector('[data-status="passed"] > .is-spinning')).toBeNull();
    expect(within(checks).getByText('Running')).toBeInTheDocument();
    expect(within(checks).getByText('Passed')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: `Stop ${jobs[0]!.test.label}` })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Clear results' })).toBeDisabled();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '2');
    fireEvent.click(screen.getByRole('button', { name: 'Stop all tests' }));
    expect(stop).toHaveBeenLastCalledWith();
  });
  it('keeps results and role counts when collapsed or remounted, with Clear results in the top toolbar', () => {
    useModelDiagnosticsStore.setState({ results: [sampleResult('main', 'passed')] });
    const view = render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    const toggle = screen.getByRole('button', { name: 'Individual checks for Main model' });
    fireEvent.click(toggle);
    expect(screen.getByText('Passed')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText('Passed')).not.toBeInTheDocument();
    expect(within(toggle).getByText('1 passed')).toBeInTheDocument();
    view.unmount();
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    fireEvent.click(screen.getByRole('button', { name: 'Individual checks for Main model' }));
    expect(screen.getByText('Passed')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: 'Test session controls' })).getByRole('button', { name: 'Clear results' }));
    expect(clear).toHaveBeenCalledOnce();
    act(() => useModelDiagnosticsStore.setState({ results: [] }));
    expect(screen.queryByText('Passed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear results' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy results as Markdown' })).toBeDisabled();
  });
  it('opens only one full-width role list at a time without starting or stopping tests', () => {
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    const main = screen.getByRole('button', { name: 'Individual checks for Main model' });
    const secondary = screen.getByRole('button', { name: 'Individual checks for Secondary tasks' });
    expect(main).toHaveAttribute('aria-expanded', 'false');
    expect(secondary).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(main);
    expect(main).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Run Encyclopedic generation / regeneration' })).toBeInTheDocument();
    fireEvent.click(secondary);
    expect(main).toHaveAttribute('aria-expanded', 'false');
    expect(secondary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: 'Run Encyclopedic generation / regeneration' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Term previews' })).toBeInTheDocument();
    fireEvent.click(secondary);
    expect(secondary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Run Term previews' })).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
  it('opens the tested role immediately and disables empty role lists', () => {
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    const main = screen.getByRole('region', { name: 'Main model tests' });
    fireEvent.click(within(main).getByRole('button', { name: 'Test role' }));
    expect(run).toHaveBeenCalledWith('main', 180, undefined);
    expect(within(main).getByRole('button', { name: 'Individual checks for Main model' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Individual checks for Image generation' })).toBeDisabled();
  });
  it('copies a Markdown snapshot of all roles, including checks still in progress', async () => {
    useModelDiagnosticsStore.setState({ running: true, results: [sampleResult('main', 'passed'), sampleResult('secondary', 'running')] });
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    fireEvent.click(within(screen.getByRole('group', { name: 'Test session controls' })).getByRole('button', { name: 'Copy results as Markdown' }));
    await waitFor(() => expect(screen.getByText('Copied (.md)')).toBeInTheDocument());
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain('# Model capability test results');
    expect(text).toContain('## Main model');
    expect(text).toContain('## Secondary tasks');
    expect(text).toContain('**Partial report:**');
    expect(text).toContain('**Passed**');
    expect(text).toContain('**Running**');
    expect(text).not.toContain('apiKey');
    expect(run).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
  it('reports a clipboard failure without clearing results or claiming success', async () => {
    writeText.mockRejectedValueOnce(new Error('Permission denied'));
    useModelDiagnosticsStore.setState({ results: [sampleResult('main', 'passed')] });
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy results as Markdown' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy results');
    expect(screen.queryByText('Copied (.md)')).not.toBeInTheDocument();
    expect(useModelDiagnosticsStore.getState().results).toHaveLength(1);
  });
  it('retains results for removed model selections inside their original role', () => {
    const result = sampleResult('main', 'failed');
    useModelDiagnosticsStore.setState({ signature: diagnosticSignature(useSettingsStore.getState()), results: [result] });
    useSettingsStore.setState({ providers: [], activeModelRef: null });
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    expect(screen.getByText('Settings changed since these tests.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Individual checks for Main model' }));
    const role = screen.getByRole('region', { name: 'Main model tests' });
    expect(within(role).getByText('Failed')).toBeInTheDocument();
    expect(within(role).getByText('Previous model selection')).toBeInTheDocument();
    expect(within(role).getByRole('button', { name: /^Run / })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy results as Markdown' })).toBeEnabled();
  });
  it('keeps unfinished tests running when their role is collapsed', () => {
    useModelDiagnosticsStore.setState({ running: true, results: [sampleResult('main', 'running')] });
    render(<ModelDiagnostics embedded />);
    fireEvent.click(screen.getByText('Test model capabilities'));
    const toggle = screen.getByRole('button', { name: 'Individual checks for Main model' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(within(toggle).getByText('1 running')).toBeInTheDocument();
    expect(useModelDiagnosticsStore.getState().running).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop all tests' })).toBeEnabled();
  });
  it('shows the guide above its parent without propagating Escape', () => {
    const closeParent = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    const show = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: show });
    render(<div onKeyDown={closeParent}><LocalModelGuide /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Local providers: connection guide' }));
    const dialog = screen.getByRole('dialog', { name: 'Local provider connections' });
    expect(show).toHaveBeenCalledOnce();
    expect(dialog).toHaveTextContent('Local image generation is not supported.');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(closeParent).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close connection guide' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    if (original) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  });
});
