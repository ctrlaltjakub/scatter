import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { getAdapter } from '@/providers/registry';
import { acceptInteractiveDraft, buildInteractiveNode, spawnInteractiveNode, stopInteractiveBuild } from './interactiveActions';
import { checkInteractiveDocument } from './interactiveProbe';
import { resetGenerationSessionsForTests } from './generationSession';
import { recoverInteractiveNode } from './interactiveRecovery';
import { isStandaloneInteractive, nodeTypeLabel } from './nodeContentType';
import { stashDetached, takeDetached } from '@/store/bgGen';
import type { StreamChatOpts } from '@/providers/types';
import { DEFAULT_SETTINGS } from '@/store/types';
import { INTERACTIVE_TOOL_ARGUMENT_LIMITS } from './interactiveDocument';
import { interactiveMetaResponse, INTERACTIVE_PLAN_FIXTURE as plan, INTERACTIVE_SCREENSHOT_FIXTURE as screenshot } from '@/test/interactiveFixture';
import { LANGUAGES, languageInfo } from './languages';

vi.mock('./interactiveProbe', async importOriginal => ({...await importOriginal<typeof import('./interactiveProbe')>(),checkInteractiveDocument:vi.fn(async()=>({ok:true,errors:[]}))}));
vi.mock('@/store/projectPersistence',()=>({flushDetachedProjectPersistence:vi.fn(()=>new Promise(()=>{})),releaseProjectPersistence:vi.fn()}));
vi.mock('@/opfs/settingsIO', async importOriginal => ({...await importOriginal<typeof import('@/opfs/settingsIO')>(),saveSettings:vi.fn(async()=>{})}));
const html='<!doctype html><html><head><title>Interactive counter</title></head><body style="background:var(--sc-bg);color:var(--sc-text);border-color:var(--sc-primary)"><button>Count</button></body></html>';
function setup() {
  const project=createBlankProject('Interactive test','source');
  project.nodes.source={id:'source',type:'explain',position:{x:0,y:0},frozen:false,currentVersionIndex:0,
    versions:[{header:'Counters explained',body:'A counter keeps track.',createdAt:1,generatedBy:'explain',contentType:'explain'}]};
  useGraphStore.setState({project,activeProjectId:project.id});
  useGraphStore.temporal.getState().resume();useGraphStore.temporal.getState().clear();
  useSettingsStore.setState({providers:[{id:'fixture',preset:'custom',apiKey:'test',baseUrl:'https://fixture.invalid',enabledModels:['code']}],
    activeModelRef:{providerId:'fixture',model:'code'},interactiveModelRef:undefined,interactiveOutputTokenCap:DEFAULT_SETTINGS.interactiveOutputTokenCap,customPrompts:undefined,
    modelCompatibilityOverrides: undefined, generationLanguage: 'en'});
  useModelCatalogStore.getState().setCatalog('fixture',[{id:'code',caps:{tools:false,textOutput:true}}]);
  return project;
}
const node=(id:string)=>useGraphStore.getState().project!.nodes[id]!;
beforeEach(()=>{vi.restoreAllMocks();resetGenerationSessionsForTests();setup();vi.mocked(checkInteractiveDocument).mockResolvedValue({ok:true,errors:[],screenshot});});
afterEach(()=>resetGenerationSessionsForTests());

describe('dedicated interactive nodes',()=>{
  it('starts with a visibility notice and updates the current check while paused', async () => {
    const id = spawnInteractiveNode('source')!;
    const invoke = vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, opts) {
      expect(node(id).versions[0]?.interactiveBuild?.steps[0]).toMatchObject({ id: 0, kind: 'info',
        label: 'Keep this tab visible during interactive generation. Browser checks may pause while the tab is in the background.' });
      yield { delta: interactiveMetaResponse(opts) ?? html, done: true };
    });
    vi.mocked(checkInteractiveDocument).mockImplementation(async (_html, _theme, _signal, _actions, _options, lifecycle) => {
      expect(lifecycle?.retryCapture).toBe(true);
      lifecycle?.onVisibilityWait?.(true);
      expect(node(id).versions[0]?.interactiveBuild?.steps.at(-1)).toMatchObject({ kind: 'paused',
        label: 'Verification paused — return to this tab to continue.' });
      lifecycle?.onVisibilityWait?.(false);
      expect(node(id).versions[0]?.interactiveBuild?.steps.at(-1)?.kind).toBeUndefined();
      return { ok: true, errors: [], screenshot };
    });
    await buildInteractiveNode(id, 'Counter', 'create');
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(node(id).versions[0]?.interactiveBuild).toMatchObject({ state: 'complete', repairPasses: 0 });
  });
  it('accepts the exact viewed draft without API calls, retaining language and allowing undo/redo', () => {
    const invoke = vi.spyOn(getAdapter('custom'), 'streamChat');
    const id = spawnInteractiveNode('source')!;
    const failed = { ...node(id).versions[0]!, language: 'ar' as const, interactiveBuild: {
      request: 'Counter', state: 'failed' as const, draftHtml: html, steps: [], plan, repairPasses: 5, error: 'Styling concern' } };
    useGraphStore.getState().updateNode(id, { versions: [failed], generationError: 'Styling concern' });
    useGraphStore.temporal.getState().clear();
    expect(acceptInteractiveDraft(id, failed.createdAt + 1)).toBe(false);
    expect(acceptInteractiveDraft(id, failed.createdAt)).toBe(true);
    expect(node(id).versions[0]).toMatchObject({ language: 'ar', interactive: { html }, interactiveBuild: { state: 'complete', acceptedByUser: true } });
    expect(node(id).generationError).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    useGraphStore.temporal.getState().undo();
    expect(node(id).versions[0]).toEqual(failed);
    useGraphStore.temporal.getState().redo();
    expect(node(id).versions[0]?.interactive?.html).toBe(html);
  });
  it('never accepts unsafe HTML or a running generation', () => {
    const id = spawnInteractiveNode('source')!;
    const version = node(id).versions[0]!;
    useGraphStore.getState().updateNode(id, { versions: [{ ...version, interactiveBuild: {
      request: 'Unsafe', state: 'failed', steps: [], draftHtml: '<!doctype html><html><body><script>fetch("https://example.com")</script></body></html>' } }] });
    expect(acceptInteractiveDraft(id, version.createdAt)).toBe(false);
    useGraphStore.getState().updateNode(id, { generating: true });
    expect(acceptInteractiveDraft(id, version.createdAt)).toBe(false);
  });
  it('resumes legacy capture failures with verification, not an unnecessary code edit', async () => {
    const id = spawnInteractiveNode('source')!;
    const source = node(id).versions[0]!;
    useGraphStore.getState().updateNode(id, { versions: [{ ...source, interactiveBuild: {
      request: 'Counter', state: 'failed', draftHtml: html, steps: [], plan, repairPasses: 4,
      error: 'Alternate-theme screenshot capture failed: No image.' } }] });
    const invoke = vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, opts) {
      expect(opts.conversation?.at(-1)?.images).toHaveLength(3);
      yield { delta: interactiveMetaResponse(opts)!, done: true };
    });
    await buildInteractiveNode(id, undefined, 'repair');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(node(id).versions[1]?.interactiveBuild).toMatchObject({ state: 'complete', repairPasses: 4 });
  });
  it('saves the plan, latest code and pass count when all five repairs fail', async () => {
    let codingCalls = 0;
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, opts) {
      yield { delta: interactiveMetaResponse(opts) ?? html.replace('Count</button>', `Count ${codingCalls++}</button>`), done: true };
    });
    vi.mocked(checkInteractiveDocument).mockResolvedValue({ ok: false, errors: ['The counter does not update'] });
    const id = spawnInteractiveNode('source')!;
    await buildInteractiveNode(id, 'Counter', 'create');
    expect(codingCalls).toBe(6);
    expect(node(id).versions[0]?.interactive).toBeUndefined();
    expect(node(id).versions[0]?.interactiveBuild).toMatchObject({ state: 'failed', plan, repairPasses: 5,
      limitReached: true, draftHtml: expect.stringContaining('Count 5'), providerId: 'fixture', model: 'code' });
    expect(node(id).generating).toBe(false);
  });
  it.each([true, false])('continues a saved draft exactly once, retaining history and language (passes: %s)', async passes => {
    const id = spawnInteractiveNode('source')!;
    const failed = { ...node(id).versions[0]!, language: 'ja' as const, interactiveBuild: {
      request: 'Counter', state: 'failed' as const, draftHtml: html, steps: [], plan, repairPasses: 5,
      limitReached: true, error: 'The counter does not update' } };
    useGraphStore.getState().updateNode(id, { versions: [failed] });
    useGraphStore.temporal.getState().clear();
    const calls: StreamChatOpts[] = [];
    const repaired = html.replace('Count</button>', 'Add one</button>');
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, opts) {
      calls.push(opts); yield { delta: interactiveMetaResponse(opts) ?? repaired, done: true };
    });
    if (!passes) vi.mocked(checkInteractiveDocument).mockResolvedValue({ ok: false, errors: ['Still broken'] });
    await buildInteractiveNode(id, passes ? 'Observed during preview: the counter is clipped' : undefined, 'repair');
    expect(calls).toHaveLength(passes ? 2 : 1);
    expect(JSON.stringify(calls[0]?.conversation)).toContain('overall pass 6');
    expect(calls[0]?.conversation?.at(-1)?.content).toContain(html);
    if (passes) expect(calls[0]?.conversation?.at(-1)?.content).toContain('Observed during preview: the counter is clipped');
    expect(node(id).versions[0]).toBe(failed);
    expect(node(id).currentVersionIndex).toBe(1);
    expect(node(id).versions[1]).toMatchObject({ language: 'ja', interactiveBuild: {
      state: passes ? 'complete' : 'failed', plan, repairPasses: 6, request: 'Counter' } });
    if (passes) expect(node(id).versions[1]?.interactive?.html).toBe(repaired);
    else expect(node(id).versions[1]?.interactiveBuild).toMatchObject({ draftHtml: repaired, limitReached: true });
    useGraphStore.temporal.getState().undo();
    expect(node(id).versions).toEqual([failed]);
    expect(node(id).generating).toBeFalsy();
  });
  it('starts over with a fresh plan without including the failed code', async () => {
    const id = spawnInteractiveNode('source')!;
    const failed = { ...node(id).versions[0]!, interactiveBuild: { request: 'Counter', state: 'failed' as const,
      draftHtml: html.replace('Count', 'FAILED DRAFT'), steps: [], plan, repairPasses: 5, limitReached: true } };
    useGraphStore.getState().updateNode(id, { versions: [failed] });
    const calls: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, opts) {
      calls.push(opts); yield { delta: interactiveMetaResponse(opts) ?? html, done: true };
    });
    await buildInteractiveNode(id);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.conversation?.at(-1)?.content).toMatch(/^Plan the program/);
    expect(JSON.stringify(calls)).not.toContain('FAILED DRAFT');
    expect(node(id).versions[0]).toBe(failed);
    expect(node(id).versions[1]?.interactiveBuild).toMatchObject({ state: 'complete', repairPasses: 0 });
  });
  it.each(LANGUAGES.map(language => language.id))('captures %s for planning, coding and review; modifications keep it', async language => {
    useSettingsStore.setState({ generationLanguage: language });
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, opts) {
      requests.push(opts);
      useSettingsStore.setState({ generationLanguage: 'en' });
      yield { delta: interactiveMetaResponse(opts) ?? html, done: true };
    });
    const id = spawnInteractiveNode('source')!;
    await buildInteractiveNode(id, 'Build a counter', 'create');
    await buildInteractiveNode(id, 'Add a reset', 'modify');
    expect(requests).toHaveLength(6);
    for (const request of requests) expect(JSON.stringify(request.conversation)).toContain(languageInfo(language).locale);
    expect(node(id).versions.every(v => v.language === language)).toBe(true);
  });
  it('requires vision, but honors an explicit compatibility bypass without skipping screenshots', async () => {
    useModelCatalogStore.getState().setCatalog('fixture', [{ id: 'code', caps: { vision: false, tools: false, textOutput: true } }]);
    const invoke = vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, opts) {
      expect(opts.allowUnverifiedCapabilities).toBe(true);
      yield { delta: interactiveMetaResponse(opts) ?? html, done: true };
    });
    const id = spawnInteractiveNode('source')!;
    await buildInteractiveNode(id, 'Counter', 'create');
    expect(invoke).not.toHaveBeenCalled();
    expect(node(id).generationError).toContain('requires vision');
    useSettingsStore.setState({ modelCompatibilityOverrides: { interactive: true } });
    await buildInteractiveNode(id, 'Counter', 'create');
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.at(-1)?.[1].conversation?.at(-1)?.images).toHaveLength(3);
    expect(node(id).versions[0]?.interactiveBuild?.state).toBe('complete');
  });
  it('uses the configured interactive allowance for actual coding requests', async()=>{
    useSettingsStore.getState().setGenerationTokenLimit('interactiveOutputTokenCap', 64000);
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){
      expect(opts.maxOutputTokens).toBe(64000); yield {delta:interactiveMetaResponse(opts) ?? html,done:true};
    });
    const id=spawnInteractiveNode('source')!;await buildInteractiveNode(id,'Build a counter','create');
    expect(node(id).versions[0]?.interactiveBuild?.state).toBe('complete');
  });
  it('creates a separate connected empty node and leaves the source unchanged',()=>{
    const source=node('source');const id=spawnInteractiveNode('source')!;
    expect(node('source')).toBe(source);expect(isStandaloneInteractive(node(id))).toBe(true);
    expect(nodeTypeLabel(node(id),false)).toBe('INTERACTIVE');
    expect(Object.values(useGraphStore.getState().project!.arrows)).toContainEqual(expect.objectContaining({fromNodeId:'source',toNodeId:id}));
    expect(useGraphStore.getState().project!.selection).toEqual([id]);
    useGraphStore.temporal.getState().undo();expect(useGraphStore.getState().project!.nodes[id]).toBeUndefined();
  });
  it('generates, validates, titles and persists a program with no explanation generation',async()=>{
    const calls:StreamChatOpts[]=[];
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){calls.push(opts);yield {delta:interactiveMetaResponse(opts) ?? html,done:true};});
    const id=spawnInteractiveNode('source')!;await buildInteractiveNode(id,'Build a counter','create');
    const v=node(id).versions[node(id).currentVersionIndex]!;
    expect(v.header).toBe('Interactive counter');expect(v.interactive?.html).toBe(html);
    expect(v.interactiveBuild?.state).toBe('complete');expect(node(id).generating).toBe(false);
    expect(calls).toHaveLength(3);expect(calls[0]?.conversation?.[1]?.content).toContain('A counter keeps track.');
    expect(calls.at(-1)?.conversation?.at(-1)?.images).toHaveLength(3);
    expect(checkInteractiveDocument).toHaveBeenCalled();
  });
  it.each([false,true])('uses the 50,000-token default for creation, modification and regeneration (tools: %s)',async supportsTools=>{
    const calls:StreamChatOpts[]=[];
    useSettingsStore.setState({interactiveReasoningEffort:'high'});
    useModelCatalogStore.getState().setCatalog('fixture',[{id:'code',caps:{tools:supportsTools,textOutput:true}}]);
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){
      calls.push(opts);
      const meta = interactiveMetaResponse(opts); if (meta) { yield {delta:meta,done:true}; return; }
      yield supportsTools ? {delta:'',done:true,toolCalls:[
        {id:'write',name:'write_document',arguments:JSON.stringify({html})},
        {id:'finish',name:'finish',arguments:'{}'},
      ]} : {delta:html,done:true};
    });
    const id=spawnInteractiveNode('source')!;
    for(const mode of ['create','modify','regenerate'] as const){
      await buildInteractiveNode(id,'Build a counter',mode);
      expect(node(id).versions[node(id).currentVersionIndex]?.interactiveBuild?.state).toBe('complete');
    }
    expect(calls).toHaveLength(9);
    for(const opts of calls) {
      expect(opts).toMatchObject({maxOutputTokens:50_000,reasoningEffort:'high'});
      expect(opts.toolArgumentLimits).toEqual(supportsTools && opts.tools?.length ? INTERACTIVE_TOOL_ARGUMENT_LIMITS : undefined);
    }
  });
  it('preserves previous code on modification and includes it in the text-only request',async()=>{
    const calls:StreamChatOpts[]=[];
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){calls.push(opts);yield {delta:interactiveMetaResponse(opts) ?? html,done:true};});
    const id=spawnInteractiveNode('source')!;await buildInteractiveNode(id,'Counter','create');
    const first=node(id).versions[0];await buildInteractiveNode(id,'Add a reset','modify');
    expect(node(id).versions[0]).toBe(first);expect(node(id).versions).toHaveLength(2);
    expect(calls[4]?.conversation?.filter(message => message.content.includes(html))).toHaveLength(1);
    expect(node(id).versions[1]?.interactive?.request).toContain('Modification: Add a reset');
  });
  it('verifies native tool output without an extra model request just to finish',async()=>{
    useModelCatalogStore.getState().setCatalog('fixture',[{id:'code',caps:{tools:true}}]);let call=0;
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){
      expect(opts.maxOutputTokens).toBe(50_000);
      const meta = interactiveMetaResponse(opts); if (meta) { yield {delta:meta,done:true}; return; }
      expect(opts.tools).toHaveLength(5);yield {delta:'',done:true,toolCalls:[{id:String(++call),name:call===1?'write_document':'finish',arguments:call===1?JSON.stringify({html}):'{}'}]};
    });
    const id=spawnInteractiveNode('source')!;await buildInteractiveNode(id,'Counter','create');
    expect(node(id).versions[0]?.interactive?.html).toBe(html);expect(call).toBe(1);
  });
  it('stops without allowing late provider output to publish',async()=>{
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){await wait;yield {delta:interactiveMetaResponse(opts) ?? html,done:true};});
    const id=spawnInteractiveNode('source')!;const pending=buildInteractiveNode(id,'Counter','create');
    stopInteractiveBuild(id);release();await pending;
    expect(node(id).versions[0]?.interactive).toBeUndefined();expect(node(id).versions[0]?.interactiveBuild?.state).toBe('stopped');
  });
  it('continues after deselection and a project switch',async()=>{
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){await wait;yield {delta:interactiveMetaResponse(opts) ?? html,done:true};});
    const id=spawnInteractiveNode('source')!;const pending=buildInteractiveNode(id,'Counter','create');
    useGraphStore.getState().setSelection([]);const previous=useGraphStore.getState().project!;stashDetached(previous);
    const next=createBlankProject('Other','other');useGraphStore.setState({project:next,activeProjectId:next.id});release();await pending;
    expect(takeDetached(previous.id)?.nodes[id]?.versions[0]?.interactive?.html).toBe(html);
    expect(useGraphStore.getState().project?.id).toBe(next.id);
  });
  it('does not resurrect deleted nodes',async()=>{
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){await wait;yield {delta:interactiveMetaResponse(opts) ?? html,done:true};});
    const id=spawnInteractiveNode('source')!;const pending=buildInteractiveNode(id,'Counter','create');
    useGraphStore.getState().deleteNodeCascade(id);release();await pending;
    expect(useGraphStore.getState().project?.nodes[id]).toBeUndefined();
  });
  it('keeps partial code after a reload without leaving a permanent build spinner',()=>{
    const id=spawnInteractiveNode('source')!;const original=node(id);
    const partial={...original,versions:[{...original.versions[0]!,interactiveBuild:{request:'Counter',state:'building' as const,draftHtml:'partial',steps:[{id:1,label:'Writing',state:'running' as const}]}}]};
    const recovered=recoverInteractiveNode(partial);
    expect(recovered.versions[0]?.interactiveBuild).toMatchObject({state:'stopped',draftHtml:'partial'});
    expect(partial.versions[0]?.interactiveBuild?.state).toBe('building');
  });
  it('keeps completed code when an unrelated action during the build is undone',async()=>{
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){await wait;yield {delta:interactiveMetaResponse(opts) ?? html,done:true};});
    const id=spawnInteractiveNode('source')!;const pending=buildInteractiveNode(id,'Counter','create');
    useGraphStore.getState().updateNode('source',{frozen:true});
    release();await pending;
    useGraphStore.temporal.getState().undo();
    expect(node('source').frozen).toBe(false);
    expect(node(id).versions[0]?.interactive?.html).toBe(html);
    expect(node(id).versions[0]?.interactiveBuild?.state).toBe('complete');
    expect(node(id).generating).toBe(false);
  });
  it('restores a stopped draft on redo without reviving an undone build',async()=>{
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){await wait;yield {delta:interactiveMetaResponse(opts) ?? html,done:true};});
    const id=spawnInteractiveNode('source')!;const pending=buildInteractiveNode(id,'Counter','create');
    useGraphStore.temporal.getState().undo();
    release();await pending;
    useGraphStore.temporal.getState().redo();
    expect(node(id).versions[0]?.interactiveBuild?.state).toBe('stopped');
    expect(node(id).generating).toBe(false);
    expect(node(id).versions[0]?.interactive).toBeUndefined();
  });
  it('does not publish late output if undo and redo both happen before the response',async()=>{
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    vi.spyOn(getAdapter('custom'),'streamChat').mockImplementation(async function*(_key,opts){await wait;yield {delta:interactiveMetaResponse(opts) ?? html,done:true};});
    const id=spawnInteractiveNode('source')!;const pending=buildInteractiveNode(id,'Counter','create');
    useGraphStore.temporal.getState().undo();useGraphStore.temporal.getState().redo();
    release();await pending;
    expect(node(id).generating).toBe(false);
    expect(node(id).versions[0]?.interactiveBuild?.state).toBe('stopped');
    expect(node(id).versions[0]?.interactive).toBeUndefined();
  });
});
