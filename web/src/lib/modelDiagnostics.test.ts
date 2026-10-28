import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/store/types';
import { diagnosticPlan, diagnosticTargets, runDiagnosticJob, runDiagnosticPlan, type DiagnosticJob, type DiagnosticResult } from './modelDiagnostics';
import { diagnosticError, GenerationResponseError, parseResponseJson, validateEncyclopedicOutput } from './generationValidation';
import { GenerationOutputLimitError } from './generationLimits';
import { ProviderError } from '@/providers/errors';
import type { ChatChunk, StreamChatOpts } from '@/providers/types';
import { LANGUAGES } from './languages';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_PROMPTS } from './promptDefaults';
import * as imageInput from './imageRegionInput';
const settings = (): Settings => ({ ...DEFAULT_SETTINGS, providers: [{ id: 'local', preset: 'custom', apiKey: 'private-test-key', baseUrl: 'http://localhost:1234/v1', enabledModels: ['a', 'b'] }],
  activeModelRef: { providerId: 'local', model: 'a' }, secondaryUseSameModel: true, secondaryModelRef: undefined, interactiveModelRef: undefined, imageModelRef: null });
afterEach(() => vi.useRealTimers());
describe('model diagnostics', () => {
  it.each(['image-selection', 'image-selection-unrelated'])('checks %s with the real image preparation path and one model request', async id => {
    const cfg = settings();
    cfg.customPrompts = { imageQuestion: 'Image reference contract: {selection}', imageQuestionSelection: 'Selection coordinates: {regions}' };
    const job = diagnosticPlan(cfg, 'main').find(job => job.test.id === id)!;
    const prepared = vi.spyOn(imageInput, 'prepareImageQuestion').mockResolvedValue({ instructions: '', images: [
      { id: 'whole-image-context', url: 'data:image/png;base64,whole', detail: 'high' },
      { id: 'selected-image-parts', url: 'data:image/png;base64,crop', detail: 'high' },
    ] });
    try {
      const invoke = vi.fn(async function* (options: StreamChatOpts) {
        expect(options.imageInputs?.map(image => image.id)).toEqual(['whole-image-context', 'selected-image-parts']);
        expect(options.messages[1]?.content).toContain('Image reference contract: Selection coordinates:');
        yield { delta: id === 'image-selection' ? '{"shape":"circle","color":"blue","code":"ORBIT 27"}' : '391', done: true };
      });
      expect((await runDiagnosticJob(job, cfg, new AbortController().signal, 'fixture-url', invoke)).status).toBe('passed');
      expect(prepared).toHaveBeenCalledWith('model-diagnostic', expect.objectContaining({ regions: job.test.imageRegions }), expect.any(AbortSignal));
      expect(invoke).toHaveBeenCalledOnce();
      expect(() => job.test.validate?.(id === 'image-selection' ? '{"shape":"triangle","color":"red","code":"ORBIT 27"}' : 'A blue circle.')).toThrow();
    } finally { prepared.mockRestore(); }
  });
  it.each([true, false])('fact-check diagnostics require actual search evidence (search=%s), with one attempt', async searched => {
    const cfg = settings(); cfg.providers[0]!.preset = 'openrouter';
    const job = diagnosticPlan(cfg, 'main').find(job => job.test.id === 'fact-check-search')!;
    const invoke = vi.fn(async function* (opts: StreamChatOpts) {
      expect(opts.webSearch).toBe(true); expect(opts.webSearchPolicy).toMatchObject({ required: true, toolChoice: 'auto', maxToolCalls: 1, maxCharacters: 5000 });
      expect(opts.messages[1]!.content).toContain('The Moon orbits Earth.');
      yield { delta: JSON.stringify({ unitId: 'sample', verdict: 'supported', explanation: 'Evidence supports it.', evidence: [
        { url: 'https://science.nasa.gov/moon/facts/', stance: 'supports', excerpt: 'The Moon orbits Earth.' }] }),
        done: true, webSearch: { used: searched }, citations: searched ? [{ url: 'https://science.nasa.gov/moon/facts/' }] : [] };
    });
    const result = runDiagnosticJob(job, cfg, new AbortController().signal, '', invoke);
    if (searched) expect((await result).status).toBe('passed');
    else await expect(result).rejects.toThrow('without confirmed web search');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each([50_000, 64_000])('uses the current %s interactive-step allowance in settings/onboarding checks', async interactiveOutputTokenCap => {
    const cfg = { ...settings(), interactiveOutputTokenCap };
    const job = diagnosticPlan(cfg, 'interactive').find(job => job.test.id === 'interactive-create')!;
    let received: StreamChatOpts | undefined;
    // Inspect request configuration without launching the browser program probe.
    await runDiagnosticJob({ ...job, test: { ...job.test, kind: 'text', validate: undefined } }, cfg, new AbortController().signal, '', async function* (opts) {
      received = opts; yield { delta: 'Complete.', done: true, finishReason: 'stop' };
    });
    expect(DEFAULT_SETTINGS.interactiveOutputTokenCap).toBe(50_000);
    expect(received?.maxOutputTokens).toBe(interactiveOutputTokenCap);
    expect(received?.reasoningEffort).toBe(cfg.interactiveReasoningEffort);
  });
  it.each(['off', 'low', 'medium', 'high', 'max'] as const)('uses the selected %s reasoning for main-model checks', async reasoningEffort => {
    const cfg = { ...settings(), reasoningEffort };
    const job = diagnosticPlan(cfg, 'main')[0]!;
    let received: StreamChatOpts | undefined;
    await runDiagnosticJob({ ...job, test: { ...job.test, validate: undefined } }, cfg, new AbortController().signal, '', async function* (opts) {
      received = opts;
      yield { delta: 'A complete answer.', done: true, finishReason: 'stop' };
    });
    expect(received?.reasoningEffort).toBe(reasoningEffort);
  });
  it('includes only the active main model and the effective role assignments', () => {
    expect(diagnosticTargets(settings()).map(t => `${t.role}:${t.model}`)).toEqual(['main:a', 'secondary:a', 'interactive:a']);
    const plan = diagnosticPlan(settings());
    expect(new Set(plan.map(j => j.key)).size).toBe(plan.length);
    for (const label of ['encyclopedic', 'explain', 'vision', 'search', 'tools', 'terms', 'previews', 'fact-check-format', 'interactive-create', 'interactive-edit', 'interactive-repair']) expect(plan.some(j => j.test.id === label)).toBe(true);
  });
  it.each(LANGUAGES)('checks explicit sentence source lines once in $name without punctuation inference', async ({ id, sample }) => {
    const cfg = { ...settings(), generationLanguage: id };
    const job = diagnosticPlan(cfg, 'main').find(job => job.test.id === 'sentence-lines')!;
    const invoke = vi.fn(async function* () {
      yield { delta: `${sample}\n${sample}`, done: true, finishReason: 'stop' as const };
    });
    expect(job.test.messages[0]!.content).toContain(DEFAULT_PROMPTS.proseLineBoundaries);
    expect((await runDiagnosticJob(job, cfg, new AbortController().signal, '', invoke)).status).toBe('passed');
    expect(invoke).toHaveBeenCalledOnce();
    expect(() => job.test.validate?.(`${sample} ${sample}`)).toThrow('two requested sentence source lines');
    expect(() => job.test.validate?.(`${sample}\n\n${sample}`)).toThrow('two requested sentence source lines');
  });
  it('keeps explicit line instructions in every prose generation/edit capability path', () => {
    useSettingsStore.setState({ ...DEFAULT_SETTINGS });
    const jobs = diagnosticPlan(settings(), 'main');
    for (const id of ['encyclopedic', 'term-node', 'follow-up', 'selected-follow-up', 'explain', 'modify', 'modify-explain',
      'elaborate', 'expand-section', 'expand-explain', 'pop-bullet', 'structure-repair', 'selection-edit', 'answer', 'answer-chunking', 'fact-rewrite', 'chat-true', 'chat-false']) {
      expect(jobs.find(job => job.test.id === id)?.test.messages[0]?.content, id).toContain(DEFAULT_PROMPTS.proseLineBoundaries);
    }
  });
  it('reports invalid preview content in a single paid capability check', async () => {
    const cfg = settings(), job = diagnosticPlan(cfg, 'secondary').find(job => job.test.id === 'previews')!;
    const invoke = vi.fn(async function* () {
      yield { delta: JSON.stringify({ previews: [{ id: 0, parts: ['The perimeter is a boundary length.\nThis is a second line.'] }] }),
        done: true, finishReason: 'stop' as const };
    });
    await expect(runDiagnosticJob(job, cfg, new AbortController().signal, '', invoke)).rejects.toThrow('perimeter: Use one line of prose');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('passes previews with abbreviated names and different emphasis without repair calls', async () => {
    const cfg = settings(), job = diagnosticPlan(cfg, 'secondary').find(job => job.test.id === 'previews')!;
    const invoke = vi.fn(async function* () {
      yield { delta: JSON.stringify({ previews: [
        { id: 0, parts: ['The perimeter is ', 'the total boundary length', ' of a shape.'] },
        { id: 1, parts: ['An equilateral triangle has three equal sides.'] },
        { id: 2, parts: ['J. R. R. Tolkien was an author known for ', 'The Hobbit', ' and ', 'The Lord of the Rings', '.'] },
      ] }), done: true, finishReason: 'stop' as const };
    });
    expect((await runDiagnosticJob(job, cfg, new AbortController().signal, '', invoke)).status).toBe('passed');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('follows the active main model across providers without changing explicit role assignments', () => {
    const cfg = settings();
    cfg.providers.push({ id: 'other', preset: 'openai', apiKey: 'test-only', enabledModels: ['c', 'd'] });
    cfg.activeModelRef = { providerId: 'other', model: 'd' };
    cfg.secondaryUseSameModel = false;
    cfg.secondaryModelRef = { providerId: 'local', model: 'a' };
    cfg.interactiveModelRef = { providerId: 'local', model: 'b' };
    expect(diagnosticTargets(cfg).map(t => `${t.role}:${t.provider.id}:${t.model}`)).toEqual([
      'main:other:d', 'secondary:local:a', 'interactive:local:b',
    ]);
    const mainJobs = diagnosticPlan(cfg, 'main');
    expect(mainJobs.length).toBeGreaterThan(0);
    expect(new Set(mainJobs.map(job => job.test.id)).size).toBe(mainJobs.length);
    expect(mainJobs.every(job => job.target.provider.id === 'other' && job.target.model === 'd')).toBe(true);
    cfg.activeModelRef = { providerId: 'local', model: 'b' };
    const switchedJobs = diagnosticPlan(cfg, 'main');
    expect(switchedJobs).toHaveLength(mainJobs.length);
    expect(switchedJobs.every(job => job.target.provider.id === 'local' && job.target.model === 'b')).toBe(true);
  });
  it.each([null, { providerId: 'missing', model: 'a' }])('does not substitute an enabled model when the active reference is %s', activeModelRef => {
    expect(diagnosticPlan({ ...settings(), activeModelRef }, 'main')).toEqual([]);
  });
  it('runs every case once and classifies timeout as inconclusive', async () => {
    vi.useFakeTimers(); const cfg = settings(), jobs = diagnosticPlan(cfg, 'secondary').slice(0, 2), results: DiagnosticResult[] = [];
    const run = vi.fn().mockRejectedValueOnce(new GenerationOutputLimitError('secondary')).mockImplementationOnce(() => new Promise(() => {}));
    const pending = runDiagnosticPlan(jobs, cfg, { run, signal: new AbortController().signal, timeoutMs: 100, onResult: r => results.push(r) });
    await vi.runAllTimersAsync(); await pending;
    expect(run).toHaveBeenCalledTimes(2);
    expect(results.filter(r => r.status !== 'running').map(r => [r.status, r.code])).toEqual([['failed', 'output_limit'], ['inconclusive', 'timeout']]);
  });
  it('starts every role and case in parallel, once each, before any result finishes', async () => {
    const cfg = settings();
    cfg.providers[0]!.enabledModels = ['a'];
    cfg.imageModelRef = cfg.activeModelRef;
    const jobs = diagnosticPlan(cfg), results: DiagnosticResult[] = [];
    const finishes = new Map<string, () => void>();
    const run = vi.fn((job: DiagnosticJob) => new Promise<{ status: 'passed'; detail: string }>(resolve => {
      finishes.set(job.key, () => resolve({ status: 'passed', detail: 'Done' }));
    }));
    const pending = runDiagnosticPlan(jobs, cfg, { run, signal: new AbortController().signal, timeoutMs: 30_000, onResult: r => results.push(r) });
    await Promise.resolve();
    expect(new Set(jobs.map(job => job.target.role)).size).toBe(4);
    expect(run).toHaveBeenCalledTimes(jobs.length);
    expect(results.every(result => result.status === 'running')).toBe(true);
    finishes.get(jobs.at(-1)!.key)!();
    await vi.waitFor(() => expect(results.filter(result => result.status === 'passed')).toHaveLength(1));
    expect(results.at(-1)?.key).toBe(jobs.at(-1)!.key);
    for (const finish of finishes.values()) finish();
    await pending;
    expect(new Set(results.filter(result => result.status === 'passed').map(result => result.key))).toEqual(new Set(jobs.map(job => job.key)));
    expect(run).toHaveBeenCalledTimes(jobs.length);
  });
  it.each(['auth', 'insufficient_credits'] as const)('aborts pending checks on a connection after %s, but not other providers', async kind => {
    const cfg = settings(), results: DiagnosticResult[] = [];
    const jobs = diagnosticPlan(cfg, 'secondary').slice(0, 3);
    jobs[2] = { ...jobs[2]!, target: { ...jobs[2]!.target, provider: { ...cfg.providers[0]!, id: 'other' } } };
    const signals: AbortSignal[] = [];
    const run = vi.fn((_job: DiagnosticJob, _settings: Settings, signal: AbortSignal) => {
      signals.push(signal);
      if (signals.length === 1) return Promise.reject(new ProviderError('Connection failure', { kind }));
      if (signals.length === 2) return new Promise<never>(() => {});
      return Promise.resolve({ status: 'passed' as const, detail: 'Done' });
    });
    await runDiagnosticPlan(jobs, cfg, { run, signal: new AbortController().signal, timeoutMs: 30_000, onResult: r => results.push(r) });
    expect(run).toHaveBeenCalledTimes(3);
    expect(signals[1]?.aborted).toBe(true);
    expect(signals[2]?.aborted).toBe(false);
    expect(results.find(r => r.key === jobs[0]!.key && r.status === 'failed')?.code).toBe(kind);
    expect(results.find(r => r.key === jobs[1]!.key && r.status === 'cancelled')?.detail).toContain('another check');
    expect(results.find(r => r.key === jobs[2]!.key && r.status === 'passed')).toBeDefined();
  });
  it('redacts provider secrets and cancels other active jobs', async () => {
    const cfg = settings(), ctrl = new AbortController(), results: DiagnosticResult[] = [];
    const run = vi.fn().mockRejectedValue(new Error('private-test-key returned invalid output'));
    await runDiagnosticPlan(diagnosticPlan(cfg, 'secondary').slice(0, 2), cfg, { run, signal: ctrl.signal, timeoutMs: 100, onResult: r => { results.push(r); if (r.status === 'failed') ctrl.abort(); } });
    expect(JSON.stringify(results)).not.toContain('private-test-key'); expect(run).toHaveBeenCalledTimes(2);
    expect(results.at(-1)?.status).toBe('cancelled');
  });
  it('stops one check without interrupting another, even when a provider ignores cancellation', async () => {
    const cfg = settings(), jobs = diagnosticPlan(cfg, 'main').slice(0, 2), results: DiagnosticResult[] = [];
    const controllers = new Map<string, AbortController>();
    let complete!: () => void;
    const run = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve({ status: 'passed', detail: 'Done' }); }));
    const pending = runDiagnosticPlan(jobs, cfg, { run, signal: new AbortController().signal, timeoutMs: 30_000,
      onController: (key, controller) => { if (controller) controllers.set(key, controller); }, onResult: r => results.push(r) });
    await Promise.resolve();
    controllers.get(jobs[0]!.key)!.abort(new DOMException('Stopped', 'AbortError'));
    expect(controllers.get(jobs[1]!.key)!.signal.aborted).toBe(false);
    complete(); await pending;
    expect(results.filter(r => r.status !== 'running').map(r => r.status)).toEqual(['cancelled', 'passed']);
    expect(results.find(r => r.status === 'cancelled')?.detail).toContain('Other checks continue');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('stops all active checks promptly and releases their controllers and timeouts', async () => {
    vi.useFakeTimers();
    const cfg = settings(), jobs = diagnosticPlan(cfg, 'secondary'), ctrl = new AbortController(), results: DiagnosticResult[] = [];
    const run = vi.fn().mockImplementation(() => new Promise(() => {}));
    const onController = vi.fn();
    const pending = runDiagnosticPlan(jobs, cfg, { run, onController, signal: ctrl.signal, timeoutMs: 30_000, onResult: r => results.push(r) });
    await Promise.resolve(); ctrl.abort(); await pending;
    expect(run).toHaveBeenCalledTimes(jobs.length);
    expect(results.filter(r => r.status === 'cancelled')).toHaveLength(jobs.length);
    expect(onController.mock.calls.filter(([, controller]) => controller === undefined)).toHaveLength(jobs.length);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['before start', 'on progress'] as const)('does not invoke providers when stopped %s', async when => {
    const cfg = settings(), ctrl = new AbortController(), results: DiagnosticResult[] = [], run = vi.fn();
    if (when === 'before start') ctrl.abort();
    const jobs = diagnosticPlan(cfg, 'secondary').slice(0, 3);
    await runDiagnosticPlan(jobs, cfg, { run, signal: ctrl.signal, timeoutMs: 30_000, onResult: r => {
      results.push(r); if (when === 'on progress' && r.status === 'running') ctrl.abort();
    } });
    expect(run).not.toHaveBeenCalled();
    expect(results.filter(r => r.status === 'cancelled')).toHaveLength(3);
  });
  it('makes exactly one tool round-trip and never executes a canvas action', async () => {
    const cfg = settings(), job = diagnosticPlan(cfg, 'main').find(j => j.test.kind === 'tools')!, calls: StreamChatOpts[] = [];
    const invoke = async function* (opts: StreamChatOpts): AsyncIterable<ChatChunk> {
      calls.push(opts); yield calls.length === 1 ? { delta: '', done: true, toolCalls: [{ id: '1', name: 'search_conversation', arguments: '{"query":"study code"}' }] }
        : { delta: 'KESTREL-42', done: true };
    };
    expect((await runDiagnosticJob(job, cfg, new AbortController().signal, 'fixture', invoke)).status).toBe('passed');
    expect(calls).toHaveLength(2); expect(calls[1]?.conversation?.at(-1)?.role).toBe('tool');
  });
  it('rejects malformed tool calls, structure, JSON and cut-off output', async () => {
    const cfg = settings(), job = diagnosticPlan(cfg, 'main').find(j => j.test.kind === 'tools')!;
    await expect(runDiagnosticJob(job, cfg, new AbortController().signal, 'fixture', async function* () {
      yield { delta: '', done: true, toolCalls: [{ id: '1', name: 'search_conversation', arguments: 'broken' }] };
    })).rejects.toThrow('valid JSON');
    expect(() => validateEncyclopedicOutput('One paragraph.')).toThrow('two-level');
    expect(() => parseResponseJson('not json')).toThrow('invalid JSON');
    expect(diagnosticError(new GenerationResponseError('interrupted', 'Cut off.', 'Retry.')).code).toBe('interrupted');
  });
});
