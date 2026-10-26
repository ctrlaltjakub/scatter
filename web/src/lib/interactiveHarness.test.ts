import { describe, expect, it, vi } from 'vitest';
import type { ChatChunk, TextToolDefinition, ProviderConversationMessage } from '@/providers/types';
import { runInteractiveHarness, replaceInteractiveText, INTERACTIVE_BUILD_LIMITS, type InteractiveStep } from './interactiveHarness';
import { INTERACTIVE_DOCUMENT_MAX_CHARS, INTERACTIVE_TOOL_ARGUMENT_LIMITS } from './interactiveDocument';

const html = '<!doctype html><html><head><title>Counter</title></head><body style="background:var(--sc-bg);color:var(--sc-text);border-color:var(--sc-primary)"><button>Count</button></body></html>';
const tools: TextToolDefinition[] = ['read_document','write_document','edit_document','check_document','finish'].map(name=>({name,description:name,parameters:{type:'object'}}));
const call = (name: string, args = {}): ChatChunk => ({delta:'',done:true,toolCalls:[{id:Math.random().toString(),name,arguments:JSON.stringify(args)}]});
function fixture(chunks: ChatChunk[], overrides: Partial<Parameters<typeof runInteractiveHarness>[0]> = {}) {
  let index=0;const history: ProviderConversationMessage[][]=[]; const steps: InteractiveStep[]=[];
  const options = { messages: [], tools, signal:new AbortController().signal,
    invoke: async function* (messages:ProviderConversationMessage[]) {history.push([...messages]);yield chunks[index++] ?? {delta:'',done:true};},
    check:vi.fn(async()=>({ok:true,errors:[] as string[]})), repairPrompt:(error:string)=>`Repair: ${error}`,onStep:(step:InteractiveStep)=>steps.push(step),onDraft:vi.fn(),...overrides };
  return {options,history,steps};
}

describe('interactive coding harness',()=>{
  it.each([false, true])('runs exactly one requested extra repair and saves a rejected result (tools: %s)', async native => {
    const next = html.replace('Count', 'Count again');
    const chunks = native ? [call('write_document', { html: next })] : [{ delta: next, done: true }];
    const onRepairPass = vi.fn();
    const f = fixture(chunks, { initialHtml: html, tools: native ? tools : [], maxRepairs: 1, repairPassOffset: 5,
      repairFeedback: 'The counter does not update', onRepairPass,
      finalCheck: vi.fn(async () => ({ ok: false, errors: ['The counter still does not update'] })) });
    await expect(runInteractiveHarness(f.options)).rejects.toMatchObject({ name: 'InteractiveBuildLimitError', repairPasses: 6 });
    expect(f.history).toHaveLength(1);
    expect(f.history[0]?.at(-1)?.content).toContain('overall pass 6');
    expect(f.history[0]?.at(-1)?.content).toContain(html);
    expect(f.history[0]?.at(-1)?.content).toContain('The counter does not update');
    expect(onRepairPass).toHaveBeenCalledExactlyOnceWith(6);
    expect(f.options.onDraft).toHaveBeenLastCalledWith(next);
    expect(f.options.finalCheck).toHaveBeenCalledExactlyOnceWith(next);
  });
  it('accepts a successful extra pass without starting another repair', async () => {
    const next = html.replace('Count', 'Add one');
    const f = fixture([{ delta: next, done: true }], { initialHtml: html, tools: [], maxRepairs: 1,
      repairPassOffset: 5, repairFeedback: 'Use a clear button label' });
    expect(await runInteractiveHarness(f.options)).toBe(next);
    expect(f.history).toHaveLength(1);
  });
  it('does not publish an unchanged draft if the requested extra pass returns only prose', async () => {
    const f = fixture([{ delta: 'It is fine.', done: true }], { initialHtml: html, tools: [], maxRepairs: 1,
      repairPassOffset: 5, repairFeedback: 'Fix the counter' });
    await expect(runInteractiveHarness(f.options)).rejects.toThrow('No program changes');
    expect(f.history).toHaveLength(1);
    expect(f.options.check).not.toHaveBeenCalled();
  });
  it('logs actual provider phases once per transition without exposing reasoning text', async () => {
    let round = 0;
    const f = fixture([], { invoke: async function* (_messages, _tools, activity) {
      activity({ phase: 'waiting' }); activity({ phase: 'reasoning' }); activity({ phase: 'reasoning' });
      activity({ phase: 'tool', tool: round++ ? 'finish' : 'write_document' });
      yield round === 1 ? call('write_document', { html }) : call('finish');
    } });
    await runInteractiveHarness(f.options);
    const starts = f.steps.filter(s => s.state === 'running').map(s => s.label);
    expect(starts.slice(0, 5)).toEqual(['Connecting to model provider', 'Waiting for model response', 'Reasoning', 'Receiving program code', 'Saving program code']);
    expect(starts.filter(s => s === 'Reasoning')).toHaveLength(2);
  });
  it('does not invent reasoning when the provider only reports text', async () => {
    const f = fixture([{ delta: html, done: true }]);
    await runInteractiveHarness(f.options);
    expect(f.steps.some(s => s.label === 'Reasoning')).toBe(false);
  });
  it('does not alternate status on every streamed HTML token', async () => {
    const f = fixture([], { invoke: async function* (_messages, _tools, activity) {
      activity({ phase: 'responding' }); yield { delta: html.slice(0, 20), done: false };
      for (let i = 20; i < html.length; i++) {
        activity({ phase: 'responding' }); yield { delta: html[i]!, done: false };
      }
      yield { delta: '', done: true };
    } });
    await runInteractiveHarness(f.options);
    expect(f.steps.filter(s => s.label === 'Receiving program code' && s.state === 'running')).toHaveLength(1);
    expect(f.steps.length).toBeLessThan(12);
  });
  it('writes and verifies a program before publishing, retaining tool results',async()=>{
    const f=fixture([call('write_document',{html}),call('check_document'),call('finish')]);
    expect(await runInteractiveHarness(f.options)).toBe(html);
    expect(f.options.check).toHaveBeenCalledTimes(2);
    expect(f.history[1]?.at(-1)?.role).toBe('tool');
    expect(f.steps.some(step=>step.label==='Checking layout and runtime'&&step.state==='complete')).toBe(true);
    expect(f.options.onDraft).toHaveBeenCalledWith(html);
  });
  it('accepts a maximum-size program even when JSON escaping greatly expands the tool arguments', async () => {
    const largeHtml = html.replace('Count', 'é'.repeat(INTERACTIVE_DOCUMENT_MAX_CHARS - html.length + 'Count'.length));
    const args = JSON.stringify({ html: largeHtml }).replaceAll('é', '\\u00e9');
    expect(largeHtml).toHaveLength(INTERACTIVE_DOCUMENT_MAX_CHARS);
    expect(args.length).toBeGreaterThan(INTERACTIVE_DOCUMENT_MAX_CHARS * 2);
    const f = fixture([{ delta: '', done: true, toolCalls: [{ id: 'write', name: 'write_document', arguments: args }] }, call('finish')]);
    expect(await runInteractiveHarness(f.options)).toBe(largeHtml);
  });
  it('allows large escaped search-and-replace inputs while keeping the final program bounded', async () => {
    const search = 'é'.repeat(100_000); const replace = 'ñ'.repeat(100_000);
    const initialHtml = html.replace('Count', search);
    const args = JSON.stringify({ search, replace }).replaceAll('é', '\\u00e9').replaceAll('ñ', '\\u00f1');
    expect(args.length).toBeGreaterThan(INTERACTIVE_DOCUMENT_MAX_CHARS * 2);
    const f = fixture([{ delta: '', done: true, toolCalls: [{ id: 'edit', name: 'edit_document', arguments: args }] }, call('finish')], { initialHtml });
    expect(await runInteractiveHarness(f.options)).toBe(html.replace('Count', replace));
  });
  it('still rejects oversized decoded programs and oversized serialized inputs before saving them', async () => {
    const tooLargeHtml = html.replace('Count', 'x'.repeat(INTERACTIVE_DOCUMENT_MAX_CHARS));
    const tooLargeArgs = ' '.repeat(INTERACTIVE_TOOL_ARGUMENT_LIMITS.write_document! + 1);
    const f = fixture([call('write_document', { html: tooLargeHtml }),
      { delta: '', done: true, toolCalls: [{ id: 'oversized', name: 'write_document', arguments: tooLargeArgs }] },
      call('write_document', { html }), call('finish')]);
    expect(await runInteractiveHarness(f.options)).toBe(html);
    expect(f.history[1]?.at(-1)?.content).toContain('Provide one complete HTML document');
    expect(f.history[2]?.at(-1)?.content).toContain('Tool input too large');
    expect(f.options.onDraft).toHaveBeenCalledExactlyOnceWith(html);
    expect(() => replaceInteractiveText(html, '<button>Count</button>', 'x'.repeat(INTERACTIVE_DOCUMENT_MAX_CHARS))).toThrow('document is too large');
  });
  it('lets the model repair a concrete checker failure',async()=>{
    const f=fixture([call('write_document',{html}),call('check_document'),call('edit_document',{search:'<button>Count</button>',replace:'<button>Add one</button>'}),call('finish')]);
    vi.mocked(f.options.check).mockResolvedValueOnce({ok:false,errors:['Button label clipped']});
    expect(await runInteractiveHarness(f.options)).toContain('Add one');
    expect(f.history[2]?.at(-1)?.content).toContain('Button label clipped');
    expect(f.steps.some(s=>s.state==='failed')).toBe(true);
  });
  it('supports models without tools and automatically checks their full document',async()=>{
    const f=fixture([{delta:html,done:true}],{tools:[]});
    expect(await runInteractiveHarness(f.options)).toBe(html);
    expect(f.options.check).toHaveBeenCalledOnce();
  });
  it.each(['finish', 'text', 'exhausted'] as const)('requires acceptance on the %s publication path', async path => {
    const finalCheck = vi.fn(async () => ({ ok: false, errors: ['The button does nothing'] }));
    const chunks = path === 'finish' ? [call('write_document', { html }), call('check_document'), call('finish')]
      : path === 'text' ? [{ delta: html, done: true }] : [call('write_document', { html })];
    const f = fixture(chunks, { finalCheck, failFast: true, maxRounds: path === 'exhausted' ? 1 : 6 });
    await expect(runInteractiveHarness(f.options)).rejects.toThrow('The button does nothing');
    expect(finalCheck).toHaveBeenCalledExactlyOnceWith(html);
  });
  it('rechecks the changed document after a rejected finish', async () => {
    const finalCheck = vi.fn().mockResolvedValueOnce({ ok: false, errors: ['Result overlaps controls'] }).mockResolvedValue({ ok: true, errors: [] });
    const f = fixture([call('write_document', { html }),
      call('edit_document', { search: '<button>Count</button>', replace: '<button>Add one</button>' })], { finalCheck });
    expect(await runInteractiveHarness(f.options)).toContain('Add one');
    expect(finalCheck.mock.calls.map(c => c[0])).toEqual([html, html.replace('<button>Count</button>', '<button>Add one</button>')]);
  });
  it('stops unchanged-code loops and does not repeat identical browser checks',async()=>{
    const f=fixture(Array.from({length:6},()=>({delta:html,done:true})),{tools:[]});
    vi.mocked(f.options.check).mockResolvedValue({ok:false,errors:['Clipped']});
    await expect(runInteractiveHarness(f.options)).rejects.toThrow('unchanged code twice');
    expect(f.options.check).toHaveBeenCalledOnce();
    expect(f.history).toHaveLength(3);
  });
  it.each([false, true])('allows all five repairs without exhausting coding turns (tools: %s)', async native => {
    const candidates = Array.from({ length: 6 }, (_, i) => html.replace('Count', `Count ${i}`));
    const chunks = native ? candidates.flatMap((candidate, i) => i === 0 ? [call('write_document', { html: candidate })]
      : [call('read_document'), call('edit_document', { search: `Count ${i - 1}`, replace: `Count ${i}` })])
      : candidates.map(delta => ({ delta, done: true }));
    const finalCheck = vi.fn(async (code: string) => ({ ok: code === candidates[5], errors: code === candidates[5] ? [] : ['Fix the real state transition.'] }));
    const base = [{ role: 'system' as const, content: 'Original requirements and fixed tests.' }];
    const f = fixture(chunks, { tools: native ? tools : [], messages: base, finalCheck });
    expect(await runInteractiveHarness(f.options)).toBe(candidates[5]);
    expect(finalCheck).toHaveBeenCalledTimes(6);
    expect(f.steps.filter(s => s.label.startsWith('Preparing targeted repair'))).toHaveLength(INTERACTIVE_BUILD_LIMITS.repairs);
    const repairRequests = f.history.filter(messages => messages.at(-1)?.content.startsWith('Targeted repair'));
    expect(repairRequests).toHaveLength(5);
    for (const messages of repairRequests) {
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual(base[0]);
      expect(messages.at(-1)?.content.match(/<!doctype html>/g)).toHaveLength(1);
      expect(messages.some(message => message.providerContent || message.toolCalls || message.role === 'tool')).toBe(false);
    }
  });
  it('automatically runs the complete acceptance gate after a tool write without paying for a finish request', async () => {
    const finalCheck = vi.fn(async () => ({ ok: true, errors: [] }));
    const f = fixture([call('write_document', { html })], { finalCheck });
    expect(await runInteractiveHarness(f.options)).toBe(html);
    expect(f.history).toHaveLength(1);
    expect(finalCheck).toHaveBeenCalledExactlyOnceWith(html);
    expect(f.steps).toContainEqual(expect.objectContaining({ label: 'Automatically verifying updated program', state: 'complete' }));
  });
  it('bounds changed but still incorrect programs to five repairs', async () => {
    const f = fixture(Array.from({ length: 9 }, (_, i) => ({ delta: html.replace('Count', `Count ${i}`), done: true })), { tools: [] });
    vi.mocked(f.options.check).mockResolvedValue({ ok: false, errors: ['Still clipped'] });
    await expect(runInteractiveHarness(f.options)).rejects.toThrow('after 5 repair passes');
    expect(f.history).toHaveLength(6);
    expect(f.options.check).toHaveBeenCalledTimes(6);
    expect(f.steps.filter(s => s.label.startsWith('Preparing targeted repair'))).toHaveLength(5);
  });
  it('does not execute tools outside the allowlist',async()=>{
    const f=fixture([call('bash',{command:'anything'}),{delta:html,done:true}]);
    await runInteractiveHarness(f.options);
    expect(f.history[1]?.at(-1)?.content).toContain('Tool not available');
  });
  it('aborts without publishing a late response',async()=>{
    const controller=new AbortController();
    const f=fixture([],{signal:controller.signal,invoke:async function*(){controller.abort();yield {delta:html,done:true};}});
    await expect(runInteractiveHarness(f.options)).rejects.toMatchObject({name:'AbortError'});
    expect(f.options.check).not.toHaveBeenCalled();
  });
  it('rejects truncated code',async()=>{
    const f=fixture([{delta:html,done:true,finishReason:'length'}]);
    await expect(runInteractiveHarness(f.options)).rejects.toThrow('output limit');
  });
  it('rejects unavailable APIs before running the browser checker',async()=>{
    const f=fixture(Array.from({length:3},()=>({delta:html.replace('Count','<script>fetch("/")</script>'),done:true})),{tools:[]});
    await expect(runInteractiveHarness(f.options)).rejects.toThrow('Network');
    expect(f.options.check).not.toHaveBeenCalled();
  });
  it('passes bounded test actions to the checker',async()=>{
    const actions=[{selector:'#count',action:'click'}];
    const f=fixture([call('write_document',{html}),call('check_document',{actions}),call('finish')]);
    await runInteractiveHarness(f.options);
    expect(f.options.check).toHaveBeenCalledWith(html,actions);
  });
  it('requires unique exact edits and treats replacement dollar signs literally',()=>{
    expect(()=>replaceInteractiveText('a a','a','b')).toThrow('not unique');
    expect(()=>replaceInteractiveText('a','b','c')).toThrow('not found');
    expect(replaceInteractiveText('abc','b','$&')).toBe('a$&c');
  });
  it('does not silently publish unchanged code when a modification produced only prose', async()=>{
    const f=fixture(Array.from({length:3},()=>({delta:'Done!',done:true})),{initialHtml:html});
    await expect(runInteractiveHarness(f.options)).rejects.toThrow('No program changes');
    expect(f.options.check).not.toHaveBeenCalled();
  });
  it('exercises custom controls with bounded keyboard actions', async()=>{
    const actions=[{selector:'#mass',action:'press',value:'ArrowRight'}];
    const f=fixture([call('write_document',{html}),call('check_document',{actions}),call('finish')]);
    await runInteractiveHarness(f.options);
    expect(f.options.check).toHaveBeenCalledWith(html,actions);
  });
});
