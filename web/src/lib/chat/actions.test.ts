import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useChatRuntimeStore, getChatDraft } from '@/store/useChatRuntimeStore';
import { getAdapter } from '@/providers/registry';
import { createChatNode, appendChatAnswer, updateChatAnswer, conversationPath, CHAT_NODE_WIDTH, chatInitialBodyHeight } from './model';
import { activateChatAnswer, askAboutChatAnswer, cancelChatEdit, compactChat, deleteChatAnswer, deleteLastChatTurn, editLastChatQuestion, forkChat, showChatAlternative, spawnChatAnswer, startChat, startFollowUpChat, stopChat, submitChat } from './actions';
import type { ChatChunk, StreamChatOpts } from '@/providers/types';
import type { Project } from '@/store/types';
import { loadAsset } from '@/opfs/assetsIO';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';
import { prepareImageQuestion } from '@/lib/imageRegionInput';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';

vi.mock('@/lib/generate', () => ({ spawnNearParent: () => ({ x: 800, y: 100 }) }));
// Prompt edits enqueue a settings save. This lifecycle test does not provide
// browser file storage, even when a busy full-suite run lets the timer fire.
vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => undefined), loadSettings: vi.fn() }));
vi.mock('./enrichment', () => ({ enrichChatAnswer: vi.fn(async () => {}), ensureAnswerTerms: vi.fn(async () => {}) }));
vi.mock('@/lib/secondaryTaskCompletion', () => ({ secondaryTaskCompletion: vi.fn(async () => 'Concise memory of earlier turns.') }));
vi.mock('@/opfs/assetsIO', () => ({ loadAsset: vi.fn(async () => new Blob(['image'], { type: 'image/png' })) }));
vi.mock('@/lib/imageRegionInput', () => ({ prepareImageQuestion: vi.fn(async () => ({
  instructions: 'Use the selected region within the whole image.', images: [
    { id: 'whole-image-context', url: 'data:image/png;base64,d2hvbGU=', detail: 'high' },
    { id: 'selected-image-parts', url: 'data:image/png;base64,c2VsZWN0ZWQ=', detail: 'high' },
  ],
})) }));

function setup() {
  const chat = createChatNode({ id: 'chat', createdAt: 1, position: { x: 40, y: 80 }, bodyHeight: 600, parentNodeId: 'parent' });
  const parent = { ...createChatNode({ id: 'parent', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 400 }), chat: undefined, type: 'root' as const };
  parent.versions[0] = { ...parent.versions[0]!, contentType: 'explain', body: 'Original parent text', header: 'Parent' };
  const project: Project = { id: 'chat-test', name: 'Chat test', createdAt: 1, updatedAt: 1, rootNodeId: 'parent',
    selection: ['chat'], viewport: { x: 0, y: 0, zoom: 0.75 }, nodes: { chat, parent }, groups: {},
    arrows: { a: { id: 'a', fromNodeId: 'parent', toNodeId: 'chat', kind: 'auto' } } };
  useGraphStore.setState({ project, activeProjectId: project.id });
  useGraphStore.temporal.getState().clear();
  useChatRuntimeStore.setState({ views: {}, drafts: {} });
  useNodeTextSelectionStore.getState().clear();
  useSettingsStore.setState({ providers: [{ id: 'fixture', preset: 'custom', apiKey: 'test-key', baseUrl: 'https://fixture.invalid/v1', enabledModels: ['vision-tools'] }],
    activeModelRef: { providerId: 'fixture', model: 'vision-tools' }, webSearch: false, outputTokenCap: 1500, normalChatInstructions: '', customPrompts: undefined, generationLanguage: 'en' });
  useModelCatalogStore.getState().setCatalog('fixture', [{ id: 'vision-tools', contextLength: 32000, caps: { tools: true, vision: true, textOutput: true } }]);
  return project;
}
const draft = (text: string) => useChatRuntimeStore.getState().setDraft('chat-test', 'chat', { text });
const chat = () => useGraphStore.getState().project!.nodes.chat!;
beforeEach(() => { vi.restoreAllMocks(); setup(); });

describe('chat action lifecycle', () => {
  it('keeps fact-check display pinned during answer navigation and closes it on sending', async () => {
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* () { yield { delta: 'A response.', done: true }; });
    draft('First'); await submitChat('chat'); draft('Second'); await submitChat('chat');
    const first = conversationPath(chat())[0]!, second = conversationPath(chat())[1]!;
    useCitationPanelStore.getState().openFact('chat', first.versionCreatedAt);
    activateChatAnswer('chat', second);
    expect(useCitationPanelStore.getState().factVersionCreatedAt).toBe(first.versionCreatedAt);
    draft('Third'); await submitChat('chat');
    expect(useCitationPanelStore.getState().mode).toBeNull();
  });
  it('creates child chats at the same larger default size as root chats', () => {
    const id = startChat('parent')!;
    expect(useGraphStore.getState().project!.nodes[id]!.versions[0]).toMatchObject({
      width: CHAT_NODE_WIDTH, bodyMaxHeight: chatInitialBodyHeight(window.innerHeight),
    });
  });
  it('captures a selected answer passage before generation and retains it on regeneration', async () => {
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      requests.push(options); yield { delta: 'A complete response.', done: true };
    });
    draft('First question'); await submitChat('chat');
    const index = chat().currentVersionIndex;
    const answer = chat().versions[index]!;
    useNodeTextSelectionStore.getState().set({ nodeId: 'chat', versionIndex: index,
      sourceBody: answer.body, start: 2, end: 10, text: 'complete' });
    draft('Explain this'); await submitChat('chat');
    expect(chat().versions.at(-1)?.chat?.reference).toMatchObject({ selectedText: 'complete', title: 'complete', versionCreatedAt: answer.createdAt });
    expect(requests[1]?.conversation?.some(message => message.content.includes('"selectedPassage":"complete"'))).toBe(true);
    useNodeTextSelectionStore.getState().clear();
    await submitChat('chat', { regenerate: true });
    expect(requests[2]?.conversation?.some(message => message.content.includes('"selectedPassage":"complete"'))).toBe(true);
  });
  it('captures language per answer before streaming and uses changes only for the next answer', async () => {
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      requests.push(options);
      useSettingsStore.setState({ generationLanguage: 'de' });
      yield { delta: 'A complete fixture answer.', done: true };
    });
    useSettingsStore.setState({ generationLanguage: 'pl' });
    draft('First question');
    await submitChat('chat');
    expect(chat().versions.at(-1)?.language).toBe('pl');
    expect(requests[0]?.conversation?.[0]?.content).toContain('Polish (pl-PL)');
    draft('Second question');
    await submitChat('chat');
    expect(chat().versions.at(-1)?.language).toBe('de');
    expect(chat().versions[1]?.language).toBe('pl');
    expect(requests[1]?.conversation?.[0]?.content).toContain('German (de-DE)');
  });
  it('explains output reservation when a 16k allowance cannot fit a fresh 16k-context chat', async () => {
    useSettingsStore.setState({ outputTokenCap: 16000 });
    useModelCatalogStore.getState().setCatalog('fixture', [{ id: 'vision-tools', contextLength: 16384,
      caps: { tools: true, vision: true, textOutput: true } }]);
    const request = vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* () {
      yield { delta: 'An answer.', done: true };
    });
    draft('Hello');
    await submitChat('chat');
    expect(request).not.toHaveBeenCalled();
    const error = useChatRuntimeStore.getState().views.chat?.error;
    expect(error).toContain('requested output allowance (16,000 tokens)');
    expect(error).toContain('16,384-token context');
    expect(error).toContain('Generation token limits');
    expect(error).toContain('Search tools and results also need space');
    expect(chat().versions.at(-1)?.chat?.state).toBe('interrupted');
    expect(getChatDraft('chat-test', 'chat').text).toBe('Hello');
    useSettingsStore.setState({ outputTokenCap: 4000 });
    await submitChat('chat');
    expect(request).toHaveBeenCalledOnce();
    expect(chat().versions.at(-1)?.body).toBe('An answer.');
  });
  it('uses the setting for new chats without changing existing chats', () => {
    useSettingsStore.setState({ defaultChatInformationChunking: false });
    const id = startChat('parent')!;
    expect(useGraphStore.getState().project!.nodes[id]?.chat?.informationChunking).toBe(false);
    expect(chat().chat?.informationChunking).toBe(true);
    useSettingsStore.setState({ defaultChatInformationChunking: true });
  });
  it('starts a routed chat immediately with the exact question and separately captured selected passage', async () => {
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      requests.push(options); yield { delta: 'Here is an email draft.', done: true };
    });
    const onSpawn = vi.fn();
    const id = startFollowUpChat('parent', 'Write an email about this', {
      selectedText: { nodeId: 'parent', versionIndex: 0, sourceBody: 'Original parent text', start: 9, end: 15, text: 'parent',
        parts: [{ sourceField: 'body', start: 9, end: 15, text: 'parent' }] }, onSpawn,
    });
    expect(onSpawn).toHaveBeenCalledOnce();
    const read = () => useGraphStore.getState().project!.nodes[id]!;
    expect(read().versions.at(-1)?.chat?.question).toBe('Write an email about this');
    await vi.waitFor(() => expect(read().generating).toBe(false));
    expect(requests[0]?.conversation?.at(-1)).toMatchObject({ role: 'user', content: 'Write an email about this' });
    expect(requests[0]?.conversation?.some(message => message.content.includes('"selectedPassage":"parent"'))).toBe(true);
    expect(Object.values(useGraphStore.getState().project!.arrows).find(arrow => arrow.toNodeId === id)?.sourceSelection?.text).toBe('parent');
    useGraphStore.getState().updateNode('parent', { versions: [{ ...useGraphStore.getState().project!.nodes.parent!.versions[0]!, body: 'Changed parent' }] });
    await submitChat(id, { regenerate: true });
    expect(requests[1]?.conversation?.some(message => message.content.includes('Original parent text'))).toBe(true);
  });
  it('keeps a routed image-region question, its atlas origin, and both image inputs together', async () => {
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      requests.push(options); yield { delta: 'This object may be unsafe.', done: true };
    });
    const imageContext = { sourceMedia: { kind: 'image' as const, source: 'asset' as const, assetId: 'photo', mime: 'image/png' },
      sourceVersionCreatedAt: 1, regions: [{ x: .2, y: .3, width: .1, height: .2 }] };
    const parent = useGraphStore.getState().project!.nodes.parent!;
    useGraphStore.getState().updateNode('parent', { versions: [{ ...parent.versions[0]!,
      contentType: 'media', media: imageContext.sourceMedia }] });
    const id = startFollowUpChat('parent', 'Should I use this?', { imageContext });
    const read = () => useGraphStore.getState().project!.nodes[id]!;
    await vi.waitFor(() => expect(read().generating).toBe(false));
    expect(read().versions.at(-1)?.chat?.question).toBe('Should I use this?');
    expect(prepareImageQuestion).toHaveBeenCalledWith('chat-test', imageContext, expect.any(AbortSignal));
    const contextMessage = requests[0]?.conversation?.find(message => message.images?.length === 2);
    expect(contextMessage?.content).toContain('Use the selected region');
    expect(contextMessage?.images?.map(image => image.id)).toEqual(['whole-image-context', 'selected-image-parts']);
    const origin = Object.values(useGraphStore.getState().project!.arrows).find(arrow => arrow.toNodeId === id)?.sourceImage;
    expect(origin).toEqual(imageContext);
    expect(origin).not.toBe(imageContext);
    await submitChat(id, { regenerate: true });
    expect(requests[1]?.conversation?.some(message => message.images?.length === 2)).toBe(true);
  });
  it('starts a routed follow-up from the visible source even while that source is still streaming', async () => {
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* () {
      yield { delta: 'Here is a draft.', done: true };
    });
    useGraphStore.getState().updateNode('parent', { generating: true, generatingVersionIndex: 0 });
    const id = startFollowUpChat('parent', 'Draft an email about this');
    const read = () => useGraphStore.getState().project!.nodes[id]!;
    expect(read().versions.at(-1)?.chat?.question).toBe('Draft an email about this');
    await vi.waitFor(() => expect(read().generating).toBe(false));
    expect(read().versions.at(-1)?.body).toBe('Here is a draft.');
    expect(Object.values(read().chat!.parentSnapshots)[0]?.body).toBe('Original parent text');
  });
  it('uses the current information-chunking choice when regenerating an existing answer', async () => {
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      requests.push(options); yield { delta: 'An answer.', done: true };
    });
    useSettingsStore.setState({ customPrompts: { chatChunking: 'Chunked output rules', chatNormal: 'Normal output rules' } });
    draft('My question');
    await submitChat('chat');
    expect(requests[0]?.conversation?.[0]?.content).toContain('Chunked output rules');
    useGraphStore.getState().updateNode('chat', { chat: { ...chat().chat!, informationChunking: false } });
    await submitChat('chat', { regenerate: true });
    expect(requests[1]?.conversation?.[0]?.content).toContain('Normal output rules');
    expect(requests[1]?.conversation?.[0]?.content).not.toContain('Chunked output rules');
    expect(chat().versions.at(-1)?.chat?.informationChunking).toBe(false);
    useGraphStore.getState().updateNode('chat', { chat: { ...chat().chat!, informationChunking: true } });
    await submitChat('chat', { regenerate: true });
    expect(requests[2]?.conversation?.[0]?.content).toContain('Chunked output rules');
    expect(chat().versions.at(-1)?.chat?.informationChunking).toBe(true);
  });
  it('sends customized chat instructions to the actual provider request without a reload', async () => {
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      requests.push(options); yield { delta: 'An answer.', done: true };
    });
    useSettingsStore.setState({ customPrompts: { chatBase: 'First custom chat system', chatChunking: 'Custom chunking rules' } });
    draft('First question'); await submitChat('chat');
    expect(requests[0]?.conversation?.[0]?.content).toContain('First custom chat system');
    expect(requests[0]?.conversation?.[0]?.content).toContain('Custom chunking rules');
    useSettingsStore.getState().setCustomPromptField('chatBase', 'Second custom chat system');
    draft('Second question'); await submitChat('chat');
    expect(requests[1]?.conversation?.[0]?.content).toContain('Second custom chat system');
    expect(requests[1]?.conversation?.[0]?.content).not.toContain('First custom chat system');
  });
  it.each([true, false])('copies an exact answer independently, preserving chunking=%s, and is undoable', (informationChunking) => {
    let current = appendChatAnswer(chat(), { turnId: 'first', createdAt: 2, question: 'Original question', metadata: { informationChunking } });
    current = updateChatAnswer(current, { turnId: 'first', versionCreatedAt: 2 }, {
      body: '## Heading\n\n**[[A term]]** matters. ⟦1⟧\n\n| A | B |\n| --- | --- |\n| 1 | 2 |',
      language: 'ja',
      sources: [{ n: 1, url: 'https://example.com', title: 'Source' }],
      googleSearchSuggestions: ['<div>Google Search</div>'],
      factCheck: { complete: { schemaVersion: 1, bodyFingerprint: 'fixture', versionCreatedAt: 2,
        providerId: 'fixture', model: 'vision-tools', startedAt: 1, completedAt: 2, complete: true, failedUnitIds: [], units: [] } },
    }, { state: 'complete', attachments: [{ id: 'private-file', name: 'Notes.txt', kind: 'text', text: 'Not copied' }] });
    current = appendChatAnswer(current, { turnId: 'second', createdAt: 3, question: 'Another question' });
    current = { ...current, generating: false, currentVersionIndex: 2 };
    useGraphStore.getState().updateNode('chat', current);
    useGraphStore.temporal.getState().clear();
    const before = structuredClone(useGraphStore.getState().project!);
    const id = spawnChatAnswer('chat', { turnId: 'first', versionCreatedAt: 2 })!;
    const project = useGraphStore.getState().project!;
    const copied = project.nodes[id]!;
    expect(copied.chat).toBeUndefined();
    expect(copied.versions).toHaveLength(1);
    expect(copied.versions[0]).toMatchObject({ body: current.versions[1]!.body, contentType: 'answer', language: 'ja',
      sources: current.versions[1]!.sources, factCheck: current.versions[1]!.factCheck,
      googleSearchSuggestions: current.versions[1]!.googleSearchSuggestions,
      chat: { informationChunking, question: 'Original question', contextPath: [] } });
    expect(copied.versions[0]?.chat?.attachments).toBeUndefined();
    expect(copied.versions[0]?.sources).not.toBe(current.versions[1]?.sources);
    expect(project.nodes.chat).toEqual({ ...before.nodes.chat, versions: before.nodes.chat!.versions.map(version => version.createdAt === 2
      ? { ...version, answerEnrichmentId: 'chat-test:chat:2' } : version) });
    expect(Object.values(project.arrows).find((arrow) => arrow.toNodeId === id)).toMatchObject({ kind: 'auto', fromNodeId: 'chat',
      sourceAnswer: { turnId: 'first', versionCreatedAt: 2 } });
    expect(JSON.parse(JSON.stringify(project)).nodes[id].versions[0].contentType).toBe('answer');
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project?.nodes[id]).toBeUndefined();
    useGraphStore.temporal.getState().redo();
    expect(useGraphStore.getState().project?.nodes[id]?.versions[0]?.body).toBe(current.versions[1]!.body);
    const childChatId = startChat(id)!;
    expect(useGraphStore.getState().project?.nodes[childChatId]?.chat?.parentNodeId).toBe(id);
    expect(useGraphStore.getState().project?.nodes[childChatId]?.chat?.turns).toEqual([]);
  });
  it('does not spawn an empty or still-generating answer', () => {
    const current = appendChatAnswer(chat(), { turnId: 'first', createdAt: 2, question: 'Pending' });
    useGraphStore.getState().updateNode('chat', current);
    expect(spawnChatAnswer('chat', { turnId: 'first', versionCreatedAt: 2 })).toBeNull();
  });
  it('puts unplaceable source keys at the end of the displayed answer', async () => {
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* () {
      yield { delta: 'First paragraph.\n\nLast paragraph.', done: true, citations: [
        { url: 'https://example.com/first', title: 'First source', startIndex: 0, endIndex: 0 },
        { url: 'https://example.com/second', title: 'Second source', startIndex: 0, endIndex: 0 },
      ] };
    });
    draft('Question'); await submitChat('chat');
    expect(chat().versions.at(-1)?.body).toBe('First paragraph.\n\nLast paragraph.\n\n⟦1⟧⟦2⟧');
    expect(chat().versions.at(-1)?.sources).toHaveLength(2);
  });
  it('restores the image MIME type lost by an OPFS storage round trip', async () => {
    vi.mocked(loadAsset).mockResolvedValueOnce(new Blob(['stored PNG bytes']));
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      requests.push(options); yield { delta: 'A visible picture.', done: true };
    });
    useChatRuntimeStore.getState().setDraft('chat-test', 'chat', { text: 'What is in this image?',
      attachments: [{ id: 'png', name: 'Screenshot.png', kind: 'image',
        media: { kind: 'image', source: 'asset', assetId: 'stored-png', mime: 'image/png' } }] });
    await submitChat('chat');
    const image = requests[0]?.conversation?.flatMap((message) => message.images ?? [])[0];
    expect(image?.url).toMatch(/^data:image\/png;base64,/);
    expect(requests[0]?.conversation?.map((message) => message.content).join('')).not.toContain('stored PNG bytes');
  });
  it('sends documents and real image input, preserving attachments through edit, regeneration and fork', async () => {
    const attachments = [{ id: 'doc', name: 'Notes.txt', kind: 'text' as const, text: 'A unique attachment fact: violet turtles.' },
      { id: 'img', name: 'Image.png', kind: 'image' as const, media: { kind: 'image' as const, source: 'asset' as const, assetId: 'image-asset' } }];
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      requests.push(options); yield { delta: 'Answer about your attachments.', done: true };
    });
    useChatRuntimeStore.getState().setDraft('chat-test', 'chat', { text: 'Explain these', attachments });
    await submitChat('chat');
    expect(chat().versions.at(-1)?.chat?.attachments).toEqual(attachments);
    expect(JSON.stringify(requests[0]?.conversation)).toContain('violet turtles');
    expect(requests[0]?.conversation?.at(-1)?.images?.[0]?.url).toMatch(/^data:image\/png;base64,/);
    expect(getChatDraft('chat-test', 'chat').attachments).toBeUndefined();
    editLastChatQuestion('chat');
    expect(getChatDraft('chat-test', 'chat').attachments).toEqual(attachments);
    cancelChatEdit('chat');
    await submitChat('chat', { regenerate: true });
    expect(chat().versions.at(-1)?.chat?.attachments).toEqual(attachments);
    const fork = forkChat('chat', conversationPath(chat()).at(-1)!)!;
    expect(useGraphStore.getState().project?.nodes[fork]?.versions.at(-1)?.chat?.attachments).toEqual(attachments);
  });
  it('can send an image-only draft and restores it when stopped', async () => {
    const attachment = { id: 'img', name: 'Image.png', kind: 'image' as const, media: { kind: 'image' as const, source: 'asset' as const, assetId: 'image-asset' } };
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* () {
      yield { delta: 'Partial answer.', done: false }; stopChat('chat'); throw new DOMException('Stopped', 'AbortError');
    });
    useChatRuntimeStore.getState().setDraft('chat-test', 'chat', { text: '', attachments: [attachment] });
    await submitChat('chat');
    expect(chat().chat?.turns).toHaveLength(1);
    expect(getChatDraft('chat-test', 'chat').attachments).toEqual([attachment]);
  });
  it('toggles asking about the exact answer without changing conversation content', () => {
    const current = appendChatAnswer(chat(), { turnId: 'first', createdAt: 2, question: 'My complete question' });
    useGraphStore.getState().updateNode('chat', current);
    useGraphStore.temporal.getState().clear();
    const ref = { turnId: 'first', versionCreatedAt: 2 };
    askAboutChatAnswer('chat', ref);
    expect(getChatDraft('chat-test', 'chat').reference).toEqual({ ...ref, title: 'My complete question' });
    askAboutChatAnswer('chat', ref);
    expect(getChatDraft('chat-test', 'chat').reference).toBeUndefined();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });
  it('rewrites the exact checked alternative, not a newer background answer, without recall tools', async () => {
    let current = appendChatAnswer(chat(), { turnId: 'first', createdAt: 2, question: 'Checked question', metadata: { informationChunking: false } });
    current = updateChatAnswer(current, { turnId: 'first', versionCreatedAt: 2 }, { body: 'Checked original answer.' }, { state: 'complete' });
    const checked = current.versions[1]!;
    current = appendChatAnswer(current, { turnId: 'first', createdAt: 3, question: 'Newer question', replaceLatest: true });
    current = updateChatAnswer(current, { turnId: 'first', versionCreatedAt: 3 }, { body: 'Unchecked newer answer.' }, { state: 'complete' });
    current = { ...current, generating: false, chat: { ...current.chat!, memory: { id: 'memory', createdAt: 4, summary: 'Earlier context', coveredPath: [] } } };
    useGraphStore.getState().updateNode('chat', current);
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      requests.push(options); yield { delta: 'Corrected answer.', done: true };
    });
    await submitChat('chat', { regenerate: true, evidence: { schemaVersion: 1, complete: true,
      bodyFingerprint: factCheckBodyFingerprint(checked), versionCreatedAt: 2, providerId: 'fixture', model: 'vision-tools',
      startedAt: 1, completedAt: 2, units: [{ id: 'opening:0', order: 0, stage: 'opening', kind: 'sentence',
        sentenceIndex: 0, text: 'Checked original answer.', state: 'complete',
        finding: { verdict: 'supported', explanation: 'Supported.', evidence: [], googleSearchSuggestions: ['<div>Google evidence attribution</div>'] } }], failedUnitIds: [] } });
    expect(chat().versions.at(-1)?.chat).toMatchObject({ question: 'Checked question', informationChunking: false });
    expect(JSON.stringify(requests[0]?.conversation)).toContain('Checked original answer.');
    expect(JSON.stringify(requests[0]?.conversation)).not.toContain('Unchecked newer answer.');
    expect(JSON.stringify(requests[0]?.conversation)).not.toContain('Google evidence attribution');
    expect(chat().versions.at(-1)?.googleSearchSuggestions).toEqual(['<div>Google evidence attribution</div>']);
    expect(requests[0]?.tools).toEqual([]);
    expect(requests[0]?.webSearch).toBe(false);
    expect(chat().versions.at(-1)?.factCheck).toBeUndefined();
  });
  it('never applies a restored stale edit to an unrelated latest turn', async () => {
    useChatRuntimeStore.getState().setDraft('chat-test', 'chat', { text: 'Keep this question', editingTurnId: 'deleted-turn' });
    await submitChat('chat');
    expect(chat().chat?.turns).toHaveLength(0);
    expect(getChatDraft('chat-test', 'chat')).toEqual({ text: 'Keep this question', reference: undefined });
    expect(useChatRuntimeStore.getState().views.chat?.error).toContain('new draft');
  });
  it('creates a usable draft while a parent generates but waits before Send', async () => {
    useGraphStore.getState().updateNode('parent', { generating: true, generatingVersionIndex: 0 });
    expect(startChat('parent')).toBeTruthy();
    draft('Question'); await submitChat('chat');
    expect(chat().chat?.turns).toHaveLength(0);
    expect(getChatDraft('chat-test', 'chat').text).toBe('Question');
    expect(useChatRuntimeStore.getState().views.chat?.error).toContain('finish');
  });
  it('creates one provisional version, streams into it and retains fixed dimensions', async () => {
    const requests: StreamChatOpts[] = [];
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      requests.push(options); yield { delta: 'First sentence. ', done: false }; yield { delta: 'Second sentence.', done: true };
    });
    draft('Question'); const pending = submitChat('chat');
    expect(chat().generating).toBe(true); expect(chat().chat?.turns).toHaveLength(1);
    expect(chat().versions.at(-1)?.bodyMaxHeight).toBe(600);
    await pending;
    expect(chat().versions.at(-1)?.body).toBe('First sentence. Second sentence.');
    expect(chat().versions.at(-1)?.chat?.state).toBe('complete');
    expect(chat().generating).toBe(false);
    expect(requests[0]?.conversation?.some((m) => m.content.includes('Original parent text'))).toBe(true);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
  });
  it('keeps an old answer readable during regeneration and Stop restores the question', async () => {
    let current = appendChatAnswer(chat(), { turnId: 'first', createdAt: 2, question: 'Original question' });
    current = { ...updateChatAnswer(current, { turnId: 'first', versionCreatedAt: 2 }, { body: 'Readable old answer.' }, { state: 'complete' }), generating: false };
    useGraphStore.getState().updateNode('chat', current);
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, options) {
      yield { delta: 'Partial answer', done: false };
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      yield { delta: '', done: true };
    });
    const pending = submitChat('chat', { regenerate: true });
    await vi.waitFor(() => expect(chat().versions.at(-1)?.body).toBe('Partial answer'));
    showChatAlternative('chat', { turnId: 'first', versionCreatedAt: 2 });
    expect(chat().versions[chat().currentVersionIndex]?.body).toBe('Readable old answer.');
    stopChat('chat'); await pending;
    expect(chat().versions.at(-1)?.chat?.state).toBe('stopped');
    expect(chat().versions[chat().currentVersionIndex]?.body).toBe('Readable old answer.');
    expect(getChatDraft('chat-test', 'chat')).toMatchObject({ text: 'Original question', editingTurnId: 'first' });
  });
  it('does not count a failed search as having searched the web', async () => {
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* () {
      yield { delta: 'A response.', done: true, webSearch: { used: false, error: 'Search unavailable' } };
    });
    draft('Question'); await submitChat('chat');
    expect(chat().versions.at(-1)?.webSearched).not.toBe(true);
    expect(chat().versions.at(-1)?.webSearchFailed).toBe(true);
  });
  it('rejects late output after the target is removed', async () => {
    let release: () => void = () => {};
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* () {
      await new Promise<void>((resolve) => { release = resolve; });
      yield { delta: 'Must not appear', done: true };
    });
    draft('Question'); const pending = submitChat('chat');
    await vi.waitFor(() => expect(chat().generating).toBe(true));
    await Promise.resolve(); await Promise.resolve();
    useGraphStore.getState().deleteNodeCascade('chat'); release(); await pending;
    expect(useGraphStore.getState().project?.nodes.chat).toBeUndefined();
  });
  it('forks a prefix with preserved dotted relations and one structural parent', () => {
    let current = appendChatAnswer(chat(), { turnId: 'first', createdAt: 2, question: 'Question' });
    current = { ...updateChatAnswer(current, { turnId: 'first', versionCreatedAt: 2 }, { body: 'About [[Go]].' }, { state: 'complete' }), generating: false };
    useGraphStore.getState().updateNode('chat', current);
    useGraphStore.getState().addNodeWithArrow(createChatNode({ id: 'child', createdAt: 3, position: { x: 1000, y: 0 }, bodyHeight: 300 }),
      { id: 'origin', kind: 'auto', fromNodeId: 'chat', toNodeId: 'child', label: 'Go', sourceAnswer: { turnId: 'first', versionCreatedAt: 2 } });
    const forkId = forkChat('chat', { turnId: 'first', versionCreatedAt: 2 })!;
    const project = useGraphStore.getState().project!;
    const reference = Object.values(project.arrows).find((a) => a.fromNodeId === forkId && a.toNodeId === 'child')!;
    expect(reference).toMatchObject({ kind: 'dotted', gravitates: false, label: 'Go' });
    expect(project.nodes[forkId]?.chat?.title).toBe('Question — forked at “Question”');
    expect(reference.sourceAnswer?.turnId).not.toBe('first');
    expect(project.arrows.origin?.kind).toBe('auto');
    const oldPosition = project.nodes.child!.position;
    // The independent fork is outside the deleted branch for this scenario.
    useGraphStore.setState({ project: { ...project, arrows: Object.fromEntries(Object.entries(project.arrows).filter(([, a]) => a.toNodeId !== forkId)) } });
    useGraphStore.getState().deleteNodeCascade('chat');
    expect(useGraphStore.getState().project?.nodes.child?.position).toEqual(oldPosition);
    expect(useGraphStore.getState().project?.arrows[reference.id]?.kind).toBe('auto');
  });
  it('deletes only the last turn while preserving the earlier active answer and draft', () => {
    let current = chat();
    for (let i = 0; i < 3; i++) current = appendChatAnswer(current, { turnId: `t${i}`, createdAt: i + 2, question: `Q${i}` });
    useGraphStore.getState().updateNode('chat', { ...current, generating: false });
    activateChatAnswer('chat', { turnId: 't0', versionCreatedAt: 2 }); draft('Keep this unsent draft');
    deleteLastChatTurn('chat');
    expect(conversationPath(chat())).toHaveLength(2);
    expect(chat().versions[chat().currentVersionIndex]?.createdAt).toBe(2);
    expect(getChatDraft('chat-test', 'chat').text).toBe('Keep this unsent draft');
  });
  it('deletes the displayed answer, cleans its UI references and restores the exact content with undo', () => {
    let current = chat();
    for (const createdAt of [2, 3, 4]) {
      current = appendChatAnswer(current, { turnId: 't', createdAt, question: `Question ${createdAt}`, replaceLatest: createdAt > 2 });
      current = updateChatAnswer(current, { turnId: 't', versionCreatedAt: createdAt }, {
        body: `Answer ${createdAt}.`, language: 'ja', sources: [{ n: 1, url: 'https://example.com' }],
      }, { state: 'complete' });
    }
    useGraphStore.getState().updateNode('chat', { ...current, generating: false, streamingText: false, generatingVersionIndex: undefined });
    const ref = { turnId: 't', versionCreatedAt: 3 };
    showChatAlternative('chat', ref);
    const before = structuredClone(chat());
    useChatRuntimeStore.getState().view('chat', { previews: { t: 3 } });
    useChatRuntimeStore.getState().setDraft('chat-test', 'chat', {
      text: 'Keep my unsent text', reference: { ...ref, title: 'Question 3' },
      previousDraft: { text: 'Previous draft', reference: { ...ref, title: 'Question 3' } },
    });
    useCitationPanelStore.getState().openFact('chat', 3);
    useNodeTextSelectionStore.getState().set({ nodeId: 'chat', versionIndex: 2, sourceBody: 'Answer 3.', text: 'Answer', start: 0, end: 6 });
    useGraphStore.temporal.getState().clear();
    deleteChatAnswer('chat', ref);
    expect(chat().chat?.turns).toEqual([{ id: 't', versionCreatedAts: [2, 4], selectedVersionCreatedAt: 2 }]);
    expect(chat().versions[chat().currentVersionIndex]?.createdAt).toBe(2);
    expect(useChatRuntimeStore.getState().views.chat).toMatchObject({ active: { turnId: 't', versionCreatedAt: 2 }, previews: {} });
    expect(getChatDraft('chat-test', 'chat')).toMatchObject({ text: 'Keep my unsent text', reference: undefined,
      previousDraft: { text: 'Previous draft', reference: undefined } });
    expect(useCitationPanelStore.getState().nodeId).toBeNull();
    expect(useNodeTextSelectionStore.getState().selection).toBeNull();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(chat().versions).toEqual(before.versions);
    expect(chat().chat).toEqual(before.chat);
    useGraphStore.temporal.getState().redo();
    expect(chat().chat?.turns[0]?.versionCreatedAts).toEqual([2, 4]);
  });
  it('keeps earlier active answers, their fact-check panels, related nodes and unfinished edits', () => {
    let current = appendChatAnswer(chat(), { turnId: 'first', createdAt: 2, question: 'First question' });
    current = appendChatAnswer(current, { turnId: 'last', createdAt: 3, question: 'Last question' });
    current = appendChatAnswer(current, { turnId: 'last', createdAt: 4, question: 'Edited question', replaceLatest: true });
    useGraphStore.getState().updateNode('chat', { ...current, generating: false });
    activateChatAnswer('chat', { turnId: 'first', versionCreatedAt: 2 });
    useCitationPanelStore.getState().openFact('chat', 2);
    useChatRuntimeStore.getState().setDraft('chat-test', 'chat', { text: 'Unfinished edit', editingTurnId: 'last' });
    const arrows = useGraphStore.getState().project!.arrows;
    const parent = useGraphStore.getState().project!.nodes.parent;
    deleteChatAnswer('chat', { turnId: 'last', versionCreatedAt: 4 });
    expect(chat().versions[chat().currentVersionIndex]?.createdAt).toBe(2);
    expect(chat().chat?.turns).toHaveLength(2);
    expect(useCitationPanelStore.getState()).toMatchObject({ nodeId: 'chat', factVersionCreatedAt: 2 });
    expect(getChatDraft('chat-test', 'chat')).toMatchObject({ text: 'Unfinished edit', editingTurnId: 'last' });
    expect(useGraphStore.getState().project!.arrows).toBe(arrows);
    expect(useGraphStore.getState().project!.nodes.parent).toBe(parent);
  });
  it('makes stale deletions harmless and blocks both deletion actions while busy', () => {
    const ref = { turnId: 't', versionCreatedAt: 3 };
    let current = appendChatAnswer(chat(), { turnId: 't', createdAt: 2, question: 'Question' });
    current = appendChatAnswer(current, { turnId: 't', createdAt: 3, question: 'Question', replaceLatest: true });
    useGraphStore.getState().updateNode('chat', current);
    deleteChatAnswer('chat', ref); deleteLastChatTurn('chat');
    expect(chat().versions).toHaveLength(3);
    useGraphStore.getState().updateNode('chat', { generating: false });
    useChatRuntimeStore.getState().view('chat', { compacting: true });
    deleteChatAnswer('chat', ref); deleteLastChatTurn('chat');
    expect(chat().versions).toHaveLength(3);
    useChatRuntimeStore.getState().view('chat', { compacting: false });
    deleteChatAnswer('chat', ref);
    useGraphStore.temporal.getState().clear();
    deleteChatAnswer('chat', ref);
    deleteChatAnswer('chat', { turnId: 't', versionCreatedAt: 2 });
    expect(chat().chat?.turns).toEqual([{ id: 't', versionCreatedAts: [2], selectedVersionCreatedAt: 2 }]);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    deleteLastChatTurn('chat');
    expect(chat().chat?.turns).toEqual([]);
    expect(chat().versions).toHaveLength(1);
    expect(chat().currentVersionIndex).toBe(0);
  });
  it('commits manual compaction as one undoable action without altering the transcript', async () => {
    let current = chat();
    for (let i = 0; i < 4; i++) {
      current = appendChatAnswer(current, { turnId: `t${i}`, createdAt: i + 2, question: `Q${i}` });
      current = updateChatAnswer(current, { turnId: `t${i}`, versionCreatedAt: i + 2 }, { body: 'A useful answer.' }, { state: 'complete' });
    }
    useGraphStore.getState().updateNode('chat', { ...current, generating: false });
    useGraphStore.temporal.getState().clear();
    expect(await compactChat('chat')).toBe(true);
    expect(chat().versions).toEqual(current.versions);
    expect(chat().chat?.memory?.summary).toContain('Concise memory');
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
  });
});
