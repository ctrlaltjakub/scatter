import { describe, expect, it, vi } from 'vitest';
import type { ProviderConversationMessage } from '@/providers/types';
import { interactiveSourceContext, parseInteractivePlan, parseInteractiveReview, runInteractiveWorkflow, type InteractiveWorkflowOptions } from './interactiveWorkflow';
import type { InteractiveStep } from './interactiveHarness';
import { DEFAULT_PROMPTS } from './promptDefaults';
import { INTERACTIVE_PLAN_FIXTURE as plan, INTERACTIVE_REVIEW_FIXTURE as review, INTERACTIVE_SCREENSHOT_FIXTURE as screenshot } from '@/test/interactiveFixture';

const html = '<!doctype html><html><body style="background:var(--sc-bg);color:var(--sc-text);border-color:var(--sc-primary)"><output id="count">0</output><button id="add">Add</button><button id="reset">Reset</button></body></html>';
function fixture(overrides: Partial<InteractiveWorkflowOptions> = {}) {
  const history: ProviderConversationMessage[][] = []; const steps: InteractiveStep[] = [];
  const options: InteractiveWorkflowOptions = { messages: [{ role: 'system', content: 'Program constraints.' }, { role: 'user', content: 'A counter, capped at one.' }],
    tools: [], signal: new AbortController().signal, planPrompt: DEFAULT_PROMPTS.interactiveNodePlan, reviewPrompt: DEFAULT_PROMPTS.interactiveNodeReview,
    invoke: async function* (messages) { history.push(structuredClone(messages));
      yield { delta: history.length === 1 ? JSON.stringify(plan) : messages.some(m => m.images?.length) ? JSON.stringify(review) : html, done: true }; },
    check: vi.fn(async () => ({ ok: true, errors: [] })), verify: vi.fn(async (_html, _actions, opts) => ({ ok: true, errors: [], screenshot: opts.screenshot ? screenshot : undefined })),
    repairPrompt: error => `Repair these failures: ${error}`, onStep: step => steps.push(step), onDraft: vi.fn(), ...overrides };
  return { options, history, steps };
}
describe('planned interactive generation and visual acceptance', () => {
  it('publishes with non-blocking warnings without a repair call', async () => {
    const onWarnings = vi.fn();
    const f = fixture({ onWarnings });
    const invoke = f.options.invoke;
    f.options.invoke = async function* (...args) {
      for await (const chunk of invoke(...args)) yield args[0].some(m => m.images?.length)
        ? { ...chunk, delta: JSON.stringify({ ...review, warnings: ['Small but readable diagram labels.'] }) } : chunk;
    };
    expect(await runInteractiveWorkflow(f.options)).toBe(html);
    expect(f.history).toHaveLength(3);
    expect(onWarnings).toHaveBeenCalledExactlyOnceWith(['Small but readable diagram labels.']);
    expect(f.steps.some(s => s.label === 'Non-blocking review notes' && s.state === 'complete')).toBe(true);
  });
  it('retries verification without a coding call or repair pass after capture failure', async () => {
    const onRepairPass = vi.fn();
    const invoke = vi.fn(async function* () { yield { delta: JSON.stringify(review), done: true }; });
    const f = fixture({ initialHtml: html, acceptedPlan: plan, verifyInitial: true, repairPassOffset: 4, onRepairPass, invoke });
    expect(await runInteractiveWorkflow(f.options)).toBe(html);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(onRepairPass).not.toHaveBeenCalled();
    expect(f.options.onDraft).not.toHaveBeenCalled();
  });
  it('retains the last real defects when a later screenshot capture fails', async () => {
    const issues = vi.fn(); let codes = 0, reviews = 0;
    const f = fixture({ onIssues: issues, invoke: async function* (messages) {
      if (messages.at(-1)?.content === DEFAULT_PROMPTS.interactiveNodePlan) yield { delta: JSON.stringify(plan), done: true };
      else if (messages.some(m => m.images?.length)) { reviews++; yield { delta: JSON.stringify({ ok: false, summary: 'Broken reset', issues: ['Reset does not work.'], warnings: [] }), done: true }; }
      else yield { delta: html.replace('Add</button>', `Add ${++codes}</button>`), done: true };
    }, verify: async (_html, _actions, options) => codes > 1
      ? { ok: false, errors: [], captureError: 'Capture unavailable' }
      : { ok: true, errors: [], screenshot: options.screenshot ? screenshot : undefined } });
    await expect(runInteractiveWorkflow(f.options)).rejects.toThrow('Screenshot capture failed');
    expect(issues).toHaveBeenCalledExactlyOnceWith(['Reset does not work.']);
    expect(reviews).toBe(1);
  });
  it('forwards compressed review images without another capture or model request', async () => {
    const jpeg = 'data:image/jpeg;base64,review-fixture';
    const f = fixture({ verify: vi.fn(async (_html, _actions, options) => ({ ok: true, errors: [], screenshot: options.screenshot ? jpeg : undefined })) });
    await runInteractiveWorkflow(f.options);
    expect(f.history).toHaveLength(3);
    expect(f.history[2]![1]!.images?.map(image => image.url)).toEqual([jpeg, jpeg, jpeg]);
  });
  it('continues with the saved plan and failure evidence without paying for a new plan', async () => {
    const onPlan = vi.fn();
    const invoke = vi.fn(async function* (messages: ProviderConversationMessage[]) {
      yield { delta: messages.some(m => m.images?.length) ? JSON.stringify(review) : html, done: true };
    });
    const f = fixture({ initialHtml: html, acceptedPlan: plan, onPlan, invoke,
      maxRepairs: 1, repairPassOffset: 5, repairFeedback: 'The reset button is clipped' });
    expect(await runInteractiveWorkflow(f.options)).toBe(html);
    expect(onPlan).toHaveBeenCalledExactlyOnceWith(plan);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]![0].some(message => message.content.includes(JSON.stringify(plan)))).toBe(true);
    expect(invoke.mock.calls[0]![0].at(-1)?.content).toContain('The reset button is clipped');
    expect(f.steps[0]?.label).toBe('Reusing saved plan and outcome tests');
    expect(f.options.verify).toHaveBeenCalledTimes(5);
  });
  it('plans before code, tests all outcomes, sends screenshots in fresh review context and logs each stage', async () => {
    const f = fixture();
    expect(await runInteractiveWorkflow(f.options)).toBe(html);
    expect(f.history).toHaveLength(3);
    expect(f.history[1]?.at(-1)?.content).toContain('fixed outcome tests');
    const request = f.history[2]!;
    expect(request).toHaveLength(2);
    expect(request[1]?.images).toEqual([{ id: 'initial', url: screenshot, detail: 'high' }, { id: 'normal', url: screenshot, detail: 'high' }, { id: 'alternate-theme', url: screenshot, detail: 'high' }]);
    expect(request[1]?.content).not.toContain('base64');
    expect(f.options.verify).toHaveBeenCalledTimes(5);
    expect(f.options.verify).toHaveBeenLastCalledWith(html, [], { assertions: plan.scenarios[0]!.assertions, screenshot: true, alternateTheme: true });
    expect(f.steps.filter(step => step.state === 'running').map(step => step.label).join('\n')).toMatch(/Planning[\s\S]*Testing initial[\s\S]*Testing normal[\s\S]*Testing boundary[\s\S]*Testing reset[\s\S]*Reviewing screenshots/);
    const completed = f.steps.filter(step => step.state === 'complete');
    expect(new Set(completed.map(step => step.id)).size).toBe(completed.length);
    expect(JSON.stringify(f.steps)).not.toContain('base64');
  });
  it('keeps the plan fixed during a repair and repeats outcome and screenshot checks on the new code', async () => {
    const f = fixture();
    const invoke = f.options.invoke;
    f.options.invoke = async function* (...args) {
      for await (const chunk of invoke(...args)) yield { ...chunk, delta: f.history.length > 2 && chunk.delta === html ? html.replace('Add</button>', 'Add one</button>') : chunk.delta };
    };
    vi.mocked(f.options.verify).mockResolvedValueOnce({ ok: false, errors: ['Expected 1, observed 0'], screenshot });
    await runInteractiveWorkflow(f.options);
    expect(f.history).toHaveLength(4); // plan, first code, repair, review
    expect(f.history[2]?.at(-1)?.content).toContain('Expected 1, observed 0');
    expect(f.options.verify).toHaveBeenCalledTimes(9);
    expect(f.steps.some(step => step.label.startsWith('Testing initial') && step.state === 'failed')).toBe(true);
  });
  it('sends only one initial and one normal screenshot even with extra scenarios of those kinds', async () => {
    const extra = { ...plan, scenarios: [...plan.scenarios, plan.scenarios[0]!, plan.scenarios[1]!] };
    const f = fixture({ invoke: async function* (messages) {
      if (messages.at(-1)?.content === DEFAULT_PROMPTS.interactiveNodePlan) yield { delta: JSON.stringify(extra), done: true };
      else if (messages.some(m => m.images?.length)) {
        expect(messages.at(-1)?.images).toHaveLength(3);
        yield { delta: JSON.stringify(review), done: true };
      } else yield { delta: html, done: true };
    } });
    await runInteractiveWorkflow(f.options);
    expect(vi.mocked(f.options.verify).mock.calls.filter(c => c[2].screenshot)).toHaveLength(3);
  });
  it('does not publish after a bad visual review, and includes targeted feedback for repair', async () => {
    let code = 0, reviews = 0;
    const f = fixture({ invoke: async function* (messages) {
      const isReview = messages.some(m => m.images?.length);
      const value = messages.at(-1)?.content === DEFAULT_PROMPTS.interactiveNodePlan ? plan
        : isReview ? ++reviews === 1 ? { ok: false, summary: 'Buttons overlap.', issues: ['Separate the overlapping Add and Reset controls.'] } : review : undefined;
      if (value) yield { delta: JSON.stringify(value), done: true };
      else { code++; yield { delta: code === 1 ? html : html.replace('Add</button>', 'Add one</button>'), done: true }; }
    } });
    expect(await runInteractiveWorkflow(f.options)).toContain('Add one');
    expect(code).toBe(2); expect(reviews).toBe(2);
  });
  it('retries a malformed review once on unchanged evidence, never accepting a claimed hypothetical fix', async () => {
    let code = 0, reviews = 0;
    const f = fixture({ invoke: async function* (messages) {
      f.history.push(structuredClone(messages));
      if (messages.at(-1)?.content === DEFAULT_PROMPTS.interactiveNodePlan) yield { delta: JSON.stringify(plan), done: true };
      else if (messages.some(m => m.images?.length)) {
        reviews++;
        yield { delta: reviews === 1 ? 'I fixed it.\n```json\n' + JSON.stringify(review) + '\n```'
          : JSON.stringify(reviews === 2 ? { ok: false, summary: 'The existing button is still clipped.', issues: ['Make the button text fit.'] } : review), done: true };
      } else { code++; yield { delta: code === 1 ? html : html.replace('Add</button>', 'Add one</button>'), done: true }; }
    } });
    expect(await runInteractiveWorkflow(f.options)).toContain('Add one');
    expect(code).toBe(2); expect(reviews).toBe(3);
    expect(f.history[3]).toHaveLength(2);
    expect(f.history[3]![0]!.content).toContain('CURRENT, UNCHANGED program');
    expect(f.history[3]![1]).toEqual(f.history[2]![1]);
    expect(JSON.stringify(f.history[3])).not.toContain('I fixed it.');
    expect(f.options.verify).toHaveBeenCalledTimes(10); // no recapture for a format-only correction
    expect(f.steps.some(step => step.label === 'Correcting review format · one retry' && step.state === 'failed')).toBe(true);
  });
  it.each([false, true])('bounds invalid review formats without approving or rewriting code (diagnostic: %s)', async failFast => {
    let reviews = 0, code = 0;
    const f = fixture({ failFast, invoke: async function* (messages) {
      if (messages.at(-1)?.content === DEFAULT_PROMPTS.interactiveNodePlan) yield { delta: JSON.stringify(plan), done: true };
      else if (messages.some(m => m.images?.length)) { reviews++; yield { delta: 'Looks fine.', done: true }; }
      else { code++; yield { delta: html, done: true }; }
    } });
    await expect(runInteractiveWorkflow(f.options)).rejects.toThrow('The program was not approved');
    expect(reviews).toBe(failFast ? 1 : 2); expect(code).toBe(1);
  });
  it('does not retry a truncated or unavailable review as if it were a formatting mistake', async () => {
    let reviews = 0;
    const f = fixture({ invoke: async function* (messages) {
      if (messages.at(-1)?.content === DEFAULT_PROMPTS.interactiveNodePlan) yield { delta: JSON.stringify(plan), done: true };
      else if (messages.some(m => m.images?.length)) { reviews++; yield { delta: '{"ok":', done: true, finishReason: 'length' }; }
      else yield { delta: html, done: true };
    } });
    await expect(runInteractiveWorkflow(f.options)).rejects.toThrow('output limit');
    expect(reviews).toBe(1);
  });
  it('does not retry failing capability checks', async () => {
    const f = fixture({ failFast: true });
    vi.mocked(f.options.verify).mockResolvedValue({ ok: false, errors: ['No state change'], screenshot });
    await expect(runInteractiveWorkflow(f.options)).rejects.toThrow('No state change');
    expect(f.history).toHaveLength(2);
  });
  it('bounds repairs and never turns repeated no-op behavior into success', async () => {
    const f = fixture();
    vi.mocked(f.options.verify).mockResolvedValue({ ok: false, errors: ['No state change'], screenshot });
    await expect(runInteractiveWorkflow(f.options)).rejects.toThrow('unchanged code twice');
    expect(f.history).toHaveLength(4); // one plan, three implementation attempts
    expect(f.options.verify).toHaveBeenCalledTimes(4); // no repeated screenshots for unchanged code
  });
  it('fails explicitly instead of silently omitting an unavailable screenshot', async () => {
    const f = fixture();
    vi.mocked(f.options.verify).mockResolvedValue({ ok: true, errors: [], captureError: 'Renderer failed' });
    await expect(runInteractiveWorkflow(f.options)).rejects.toThrow('Screenshot capture failed');
    expect(f.history).toHaveLength(2);
  });
  it('does not approve when the alternate theme cannot be captured', async () => {
    const f = fixture({ verify: async (_html, _actions, options) => options.alternateTheme
      ? { ok: true, errors: [], captureError: 'Renderer failed' } : { ok: true, errors: [], screenshot } });
    await expect(runInteractiveWorkflow(f.options)).rejects.toThrow('Alternate-theme screenshot capture failed');
    expect(f.history).toHaveLength(2);
  });
  it('does not retry an invalid diagnostic plan or a truncated plan', async () => {
    const f = fixture({ failFast: true, invoke: async function* () { yield { delta: '{}', done: true }; } });
    await expect(runInteractiveWorkflow(f.options)).rejects.toThrow('Invalid interactive plan');
    expect(f.options.onDraft).not.toHaveBeenCalled();
    const truncated = fixture({ invoke: async function* () { yield { delta: '{}', done: true, finishReason: 'length' }; } });
    await expect(runInteractiveWorkflow(truncated.options)).rejects.toThrow('output limit');
  });
  it('corrects an invalid plan once before coding, without weakening its outcome tests', async () => {
    let calls = 0;
    const wrongKind = { ...plan, scenarios: plan.scenarios.map(s => ({ ...s, kind: s.kind === 'reset' ? 'normal' : s.kind })) };
    const f = fixture({ invoke: async function* (messages) {
      calls++;
      if (calls === 2) expect(messages.at(-1)?.content).toContain('include initial, normal, boundary, and reset');
      yield { delta: calls === 1 ? JSON.stringify(wrongKind) : calls === 2 ? JSON.stringify(plan)
        : messages.some(m => m.images?.length) ? JSON.stringify(review) : html, done: true };
    } });
    expect(await runInteractiveWorkflow(f.options)).toBe(html);
    expect(calls).toBe(4);
    expect(f.steps.some(s => s.label === 'Correcting the plan format · one retry' && s.state === 'complete')).toBe(true);
    expect(f.options.verify).toHaveBeenCalledWith(html, plan.scenarios[3]!.actions, { assertions: plan.scenarios[3]!.assertions, screenshot: false });
  });
  it('does not loop if the corrected plan remains invalid', async () => {
    let calls = 0;
    const f = fixture({ invoke: async function* () { calls++; yield { delta: '{}', done: true }; } });
    await expect(runInteractiveWorkflow(f.options)).rejects.toThrow('Invalid interactive plan');
    expect(calls).toBe(2); expect(f.options.onDraft).not.toHaveBeenCalled();
  });
  it('cancels during screenshot capture without invoking review or publishing', async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal, verify: async () => { controller.abort(); return { ok: true, errors: [], screenshot }; } });
    await expect(runInteractiveWorkflow(f.options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.history).toHaveLength(2);
  });
  it('refuses malformed or contradictory visual-review verdicts', () => {
    expect(() => parseInteractiveReview('{"ok":true,"summary":"Fine","issues":[],"warnings":[42]}')).toThrow('invalid verdict');
    expect(parseInteractiveReview('{"ok":true,"summary":"Fine","issues":[],"warnings":["Readable 11px label"]}').ok).toBe(true);
    expect(() => parseInteractiveReview('{"ok":true,"summary":"Fine","issues":["Broken"]}')).toThrow('invalid verdict');
    expect(() => parseInteractiveReview('{"ok":false,"summary":"Fine","issues":[]}')).toThrow('invalid verdict');
    expect(() => parseInteractivePlan(JSON.stringify({ ...plan, scenarios: plan.scenarios.slice(0, 2) }))).toThrow('four to six');
  });
  it('includes relevant late source content without forwarding embedded image bytes', () => {
    const body = 'Introduction. '.repeat(4000) + '\nSpecific quasar calculation QX991 is y=2*x.\n' + 'Unrelated. '.repeat(4000);
    const context = interactiveSourceContext('Source', body, 'QX991 quasar calculation');
    expect(context).toContain('QX991'); expect(context).toContain('Source excerpted');
    expect(context.length).toBeLessThan(41_000);
    expect(interactiveSourceContext('Image', '![x](data:image/png;base64,abcd)', 'image')).not.toContain('base64');
  });
});
