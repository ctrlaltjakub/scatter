import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/store/types';
import type { StreamChatOpts } from '@/providers/types';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { diagnosticPlan, runDiagnosticJob } from './modelDiagnostics';
import { checkInteractiveDocument } from './interactiveProbe';
import { diagnosticError } from './generationValidation';
import { GenerationOutputLimitError } from './generationLimits';
import { InteractiveVerificationError } from './interactiveHarness';
import { interactiveMetaResponse, INTERACTIVE_SCREENSHOT_FIXTURE as screenshot } from '@/test/interactiveFixture';

vi.mock('./interactiveProbe', () => ({ checkInteractiveDocument: vi.fn() }));
const html = '<!doctype html><html><body style="background:var(--sc-bg);color:var(--sc-text);border-color:var(--sc-primary)"><output id="count">0</output><button id="add">Add</button><button id="reset">Reset</button></body></html>';
const settings = (): Settings => ({ ...DEFAULT_SETTINGS, providers: [{ id: 'local', preset: 'custom', apiKey: 'test', enabledModels: ['vision-model'] }],
  activeModelRef: { providerId: 'local', model: 'vision-model' }, interactiveModelRef: undefined, customPrompts: undefined });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(checkInteractiveDocument).mockResolvedValue({ ok: true, errors: [], screenshot }); });

describe('interactive capability diagnostics use the real workflow', () => {
  it('does not enable production capture retries in an explicit capability check', async () => {
    const cfg = settings(), job = diagnosticPlan(cfg, 'interactive').find(j => j.test.id === 'interactive-create')!;
    vi.mocked(checkInteractiveDocument).mockImplementation(async (_html, _theme, _signal, _actions, options, lifecycle) => {
      expect(lifecycle?.retryCapture).not.toBe(true);
      return options?.screenshot ? { ok: false, errors: [], captureError: 'Browser returned no usable screenshot' } : { ok: true, errors: [] };
    });
    const invoke = vi.fn(async function* (options: StreamChatOpts) { yield { delta: interactiveMetaResponse(options) ?? html, done: true }; });
    await expect(runDiagnosticJob(job, cfg, new AbortController().signal, '', invoke)).rejects.toThrow('Screenshot capture failed');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(vi.mocked(checkInteractiveDocument).mock.calls.filter(call => call[4]?.screenshot)).toHaveLength(1);
  });
  it('reports non-blocking notes as a passing check without retries', async () => {
    const cfg = settings(), job = diagnosticPlan(cfg, 'interactive').find(j => j.test.id === 'interactive-create')!;
    const invoke = vi.fn(async function* (options: StreamChatOpts) {
      yield { delta: options.conversation?.some(m => m.images?.length)
        ? JSON.stringify({ ok: true, summary: 'Working calculator', issues: [], warnings: ['Small readable label.'] })
        : interactiveMetaResponse(options) ?? html, done: true };
    });
    const result = await runDiagnosticJob(job, cfg, new AbortController().signal, '', invoke);
    expect(result.status).toBe('passed');
    expect(result.detail).toContain('Non-blocking review notes: Small readable label.');
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(job.test.messages)).toContain('--sc-on-primary');
    expect(vi.mocked(checkInteractiveDocument).mock.calls[0]?.[1]).toMatchObject({ primary: '#60a5fa', onPrimary: '#000000' });
  });
  it.each([false, true])('checks planning, outcomes, screenshots and independent results (tools: %s)', async tools => {
    useModelCatalogStore.getState().setCatalog('local', [{ id: 'vision-model', caps: { vision: true, tools } }]);
    const cfg = settings();
    const job = diagnosticPlan(cfg, 'interactive').find(j => j.test.id === 'interactive-edit')!;
    const requests: StreamChatOpts[] = [];
    const result = await runDiagnosticJob(job, cfg, new AbortController().signal, '', async function* (options) {
      requests.push(options);
      const meta = interactiveMetaResponse(options);
      if (meta) { yield { delta: meta, done: true }; return; }
      expect(!!options.tools?.length).toBe(tools);
      if (!tools) expect(JSON.stringify(options.conversation)).toContain('Current document');
      yield tools ? { delta: '', done: true, toolCalls: [{ id: 'write', name: 'write_document', arguments: JSON.stringify({ html }) }, { id: 'finish', name: 'finish', arguments: '{}' }] }
        : { delta: html, done: true };
    });
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(requests.at(-1)?.conversation?.at(-1)?.images).toHaveLength(3);
    expect(checkInteractiveDocument).toHaveBeenLastCalledWith(html, expect.anything(), expect.anything(), [{ action: 'click', selector: '#add' }], {
      assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: '2' }],
    });
  });
  it('never repairs or retries a failed diagnostic plan', async () => {
    const cfg = settings(), job = diagnosticPlan(cfg, 'interactive').find(j => j.test.id === 'interactive-create')!;
    let calls = 0;
    await expect(runDiagnosticJob(job, cfg, new AbortController().signal, '', async function* () {
      calls++; yield { delta: '{}', done: true };
    })).rejects.toThrow('Invalid interactive plan');
    expect(calls).toBe(1); expect(checkInteractiveDocument).not.toHaveBeenCalled();
  });
  it.each([false, true])('tests a targeted repair once using existing code and concrete failure evidence (tools: %s)', async tools => {
    useModelCatalogStore.getState().setCatalog('local', [{ id: 'vision-model', caps: { vision: true, tools } }]);
    const cfg = settings(), job = diagnosticPlan(cfg, 'interactive').find(j => j.test.id === 'interactive-repair')!;
    const requests: StreamChatOpts[] = [];
    const result = await runDiagnosticJob(job, cfg, new AbortController().signal, '', async function* (options) {
      requests.push(options);
      const meta = interactiveMetaResponse(options);
      if (meta) { yield { delta: meta, done: true }; return; }
      const conversation = JSON.stringify(options.conversation);
      expect(conversation).toContain('observed \\"0\\"');
      expect(conversation).toContain('Current document');
      expect(conversation).toContain('n=Math.min(3,n+1)');
      expect(conversation).toContain('overall pass 6');
      expect(conversation).toContain('Stops at three');
      yield tools ? { delta: '', done: true, toolCalls: [
        { id: 'edit', name: 'edit_document', arguments: JSON.stringify({ search: 'n=Math.min(3,n+1)', replace: 'n=Math.min(3,n+1);document.getElementById("count").textContent=String(n)' }) },
        { id: 'finish', name: 'finish', arguments: '{}' },
      ] } : { delta: html, done: true };
    });
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(2);
    expect(checkInteractiveDocument).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), expect.anything(), [{ action: 'click', selector: '#add' }], {
      assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: '1' }],
    });
  });
  it('does not use the extra production repair allowance during a capability check', async () => {
    const cfg = settings(), job = diagnosticPlan(cfg, 'interactive').find(j => j.test.id === 'interactive-repair')!;
    vi.mocked(checkInteractiveDocument).mockResolvedValue({ ok: false, errors: ['The repair still leaves #count at 0'], screenshot });
    const invoke = vi.fn(async function* (options: StreamChatOpts) { yield { delta: interactiveMetaResponse(options) ?? html, done: true }; });
    await expect(runDiagnosticJob(job, cfg, new AbortController().signal, '', invoke)).rejects.toThrow('still leaves #count at 0');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('retains the precise error category when a visual-review request fails', () => {
    expect(diagnosticError(new InteractiveVerificationError('Visual review reached its limit', { cause: new GenerationOutputLimitError('interactive') })))
      .toMatchObject({ status: 'failed', code: 'output_limit' });
    expect(diagnosticError(new InteractiveVerificationError('Visual review timed out', { cause: new DOMException('Timed out', 'TimeoutError') })))
      .toMatchObject({ status: 'inconclusive', code: 'timeout' });
  });
});
