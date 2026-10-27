import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { completeTermPreviews, inspectTermPreviews, parseTermPreviews, previewTerms, previewRequest, reusableTermPreviews, termPreviewFor, termPreviewFingerprint } from './termPreviewCore';
import { LANGUAGES } from './languages';
import { generateTermPreviews, termPreviewProcess, watchFocusedTermPreviews } from './termPreviews';
import type { NodeVersion } from '@/store/types';
import { appendChatAnswer, createChatNode, updateChatAnswer } from './chat/model';
import { enrichChatAnswer, ensureAnswerTerms, redoChatTerms } from './chat/enrichment';
import { answerEnrichmentError } from './chat/sharedEnrichment';
import { redoTermMarking } from './generate';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { spawnChatAnswer } from './chat/actions';
import { saveManualEdit } from './generate';

const complete = vi.hoisted(() => vi.fn());
vi.mock('./secondaryTaskCompletion', () => ({ secondaryTaskCompletion: complete }));
const parts = ['A cache is a ', 'temporary store', ' that enables ', 'faster access', ' to previously retrieved data.'];
const explanation = 'A cache is a **temporary store** that enables **faster access** to previously retrieved data.';
const version = (body = 'A [[cache]] is useful.'): NodeVersion => ({
  header: 'Computing', body, generatedBy: 'root', contentType: 'encyclopedic', createdAt: 10,
});
const result = (ids: number[]) => JSON.stringify({ previews: ids.map(id => ({ id, parts })) });
function seed(body?: string) {
  const project = createBlankProject('Previews', 'n');
  project.nodes.n = { id: 'n', type: 'root', position: { x: 0, y: 0 }, frozen: false,
    versions: [version(body)], currentVersionIndex: 0 };
  project.selection = ['n'];
  useGraphStore.getState().setProject(project);
  useGraphStore.setState({ activeProjectId: project.id });
  useGraphStore.temporal.getState().clear();
  return project;
}
const current = () => useGraphStore.getState().project!.nodes.n!.versions[0]!;

function seedChat() {
  let node = createChatNode({ id: 'n', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 400 });
  for (const [turnId, createdAt] of [['first', 10], ['first', 11], ['second', 12]] as const) {
    node = appendChatAnswer(node, { turnId, createdAt, question: `Question ${createdAt}`, replaceLatest: createdAt === 11 });
    node = updateChatAnswer(node, { turnId, versionCreatedAt: createdAt }, { body: `Answer ${createdAt} uses a [[cache]].` }, { state: 'complete' });
  }
  node = { ...node, generating: false, streamingText: false, generatingVersionIndex: undefined };
  const project = { ...createBlankProject('Chat previews', 'n'), nodes: { n: node }, selection: ['n'] };
  useGraphStore.setState({ project, activeProjectId: project.id });
  useGraphStore.temporal.getState().clear();
  return project;
}
const chatVersion = (createdAt: number) => useGraphStore.getState().project!.nodes.n!.versions.find(v => v.createdAt === createdAt)!;

describe('term preview data', () => {
  it('includes whole encyclopedia titles, deduplicates case, excludes code and link literals', () => {
    expect(previewTerms(version('**[[Cache]]** uses [[cache]]. `[[literal]]` [link [[ignored]]](https://example.com)\n\n- **[[Memory]]** management\n  - [[Page]] faults: A [[page]] may be missing.')))
      .toEqual(['cache', 'Memory', 'page', 'Memory management', 'Page faults']);
  });
  it.each(['chat', 'answer', 'explain'] as const)('extracts marked terms without inventing whole-title terms in %s prose', (contentType) => {
    expect(previewTerms({ ...version('- Title: [[cache]]'), contentType })).toEqual(['cache']);
  });
  it('skips media versions', () => {
    expect(previewTerms({ ...version(), contentType: 'media' })).toEqual([]);
  });
  it('assembles emphasis and rejects malformed, duplicate, unknown and multiline entries', () => {
    expect(parseTermPreviews(result([0]), ['cache'])).toEqual({ cache: explanation });
    expect(parseTermPreviews(JSON.stringify({ previews: [
      { id: 0, parts: [] }, { id: 99, parts },
      { id: 1, parts: ['First ', 'fact', '.\nSecond ', 'fact', '.'] },
      { id: 2, parts: ['Unsafe <img> ', 'tag', ' with ', 'text', '.'] },
    ] }), ['a', 'b', 'c'])).toEqual({});
  });
  it('safely normalizes whitespace inside bold parts without changing the sentence', () => {
    const padded = parts.map((part, i) => i % 2 ? ` ${part} ` : part);
    expect(parseTermPreviews(JSON.stringify({ previews: [{ id: 0, parts: padded }] }), ['cache'])).toEqual({ cache: explanation });
  });
  it('accepts the real chat response with only one bold phrase without retrying', async () => {
    const singleBold = ['Screenshots are ', 'static images of an app’s interface', ' that let visitors see its appearance and functions before using it, making them useful on landing pages and in READMEs.'];
    const call = vi.fn().mockResolvedValue(JSON.stringify({ previews: [{ id: 0, parts: singleBold }] }));
    const commit = vi.fn();
    expect(await completeTermPreviews(version(), ['screenshots'], call, commit)).toEqual([]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0].screenshots).toBe(`${singleBold[0]}**${singleBold[1]}**${singleBold[2]}`);
  });
  it.each([
    ['no emphasis', ['A cache stores data for faster access.'], 'A cache stores data for faster access.'],
    ['empty bold positions', ['A cache ', '', 'stores data ', '', 'for faster access.'], 'A cache stores data for faster access.'],
    ['even part count', ['A cache ', 'stores data for faster access.'], 'A cache **stores data for faster access.**'],
    ['four bold phrases', ['A ', 'cache', ' ', 'stores', ' ', 'data', ' for ', 'faster access', '.'], 'A **cache** **stores** **data** for **faster access**.'],
    ['inline Markdown', ['A cache **stores data** for __faster access__.'], 'A cache **stores data** for **faster access**.'],
    ['inline Markdown in a bold position', ['A cache ', '**stores data**', ' for faster access.'], 'A cache **stores data** for faster access.'],
    ['unbalanced Markdown', ['A cache **stores data for faster access.'], 'A cache stores data for faster access.'],
    ['long bold phrase', ['', 'A cache stores previously requested data close to the code that needs it so subsequent requests can retrieve that data more quickly.', ''], '**A cache stores previously requested data close to the code that needs it so subsequent requests can retrieve that data more quickly.**'],
  ])('accepts %s as presentation rather than a generation failure', (_name, previewParts, expected) => {
    const accepted = inspectTermPreviews(JSON.stringify({ previews: [{ id: 0, parts: previewParts }] }), ['cache']);
    expect(accepted).toEqual({ entries: { cache: expected }, issues: {} });
  });
  it('repairs invalid content with the rejected draft and exact error, without redoing accepted previews', async () => {
    const rejected = ['Screenshots show ', 'an app’s interface', '.\nThey demonstrate features.'];
    const fixed = ['Screenshots are ', 'images captured from an app’s screen', ' that ', 'demonstrate its features', ' before a reader tries the product.'];
    const call = vi.fn().mockResolvedValueOnce(JSON.stringify({ previews: [
      { id: 0, parts }, { id: 1, parts: rejected },
    ] })).mockResolvedValueOnce(JSON.stringify({ previews: [{ id: 0, parts: fixed }] }));
    const commit = vi.fn();
    expect(await completeTermPreviews(version(), ['cache', 'screenshots'], call, commit)).toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
    const repair = call.mock.calls[1]![0];
    expect(repair.system).toContain('This is a repair request');
    expect(JSON.parse(repair.user).terms).toEqual([{ id: 0, term: 'screenshots', repair: {
      reason: expect.stringContaining('one line of prose'), previousParts: rejected,
    } }]);
    expect(commit.mock.calls[0]![0]).toEqual({ cache: explanation });
    expect(commit.mock.calls[1]![0]).toEqual({ screenshots: 'Screenshots are **images captured from an app’s screen** that **demonstrate its features** before a reader tries the product.' });
  });
  it('reports format, missing-entry and malformed-JSON failures separately', () => {
    expect(inspectTermPreviews('{', ['cache']).issues.cache?.reason).toContain('not valid JSON');
    expect(inspectTermPreviews('{"previews":[]}', ['cache']).issues.cache?.reason).toContain('No preview');
    const malformed = ['A cache ', 'stores data', '.\nIt ', 'improves speed', '.'];
    expect(inspectTermPreviews(JSON.stringify({ previews: [{ id: 0, parts: malformed }] }), ['cache']).issues.cache?.reason).toContain('one line of prose');
  });
  it.each([
    'Aphex Twin is the alias of Richard D. James, a musician known for experimental electronic music.',
    'W. B. Yeats was an Irish poet associated with the literary revival.',
    'St. Irvyne is a Gothic novel by Percy Bysshe Shelley.',
    'Dr. Johann Adam Schmidt was a physician who treated Beethoven.',
    'Chopin’s Nocturne Op. 9, No. 2 is a piano work in E-flat major.',
    'The U.S. economy includes a range of industries.',
    'Dr. Müller misst z. B. eine Länge von 3.14 Metern.',
    'Prof. Kowalski podaje np. wartość 3.14 jako przybliżenie.',
    'Capt. J. B. Vance confirms a consultation appt. with Dr. Stith Jr. at approx. 10:30 a.m.',
    'Smith & Co. Ltd. audited the est. laboratory fees vs. the actual billing records.',
  ])('accepts a single sentence containing abbreviated names or titles: %s', sentence => {
    const raw = JSON.stringify({ previews: [{ id: 0, parts: [sentence] }] });
    expect(inspectTermPreviews(raw, ['term'])).toEqual({ entries: { term: sentence }, issues: {} });
  });
  it.each(LANGUAGES)('keeps valid $name preview prose unchanged through validation', ({ id, sample }) => {
    // Split at grapheme boundaries, including CJK/Devanagari and RTL text.
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(sample)].map(part => part.segment);
    const a = Math.floor(graphemes.length / 3), b = Math.floor(graphemes.length * 2 / 3);
    const localized = ['', graphemes.slice(0, a).join(''), '', graphemes.slice(a, b).join(''), graphemes.slice(b).join('')];
    const accepted = inspectTermPreviews(JSON.stringify({ previews: [{ id: 0, parts: localized }] }), [id]);
    expect(accepted.issues).toEqual({});
    expect(accepted.entries[id]!.replace(/\*\*/g, '')).toBe(sample);
    expect(inspectTermPreviews(JSON.stringify({ previews: [{ id: 0, parts: [sample] }] }), [id]))
      .toEqual({ entries: { [id]: sample }, issues: {} });
    expect(inspectTermPreviews(JSON.stringify({ previews: [{ id: 0, parts: [`${sample} ${sample}`] }] }), [id]).entries)
      .toEqual({ [id]: `${sample} ${sample}` });
  });
  it('does not spend repair requests guessing grammatical sentence counts', async () => {
    const text = 'A cache stores data. It makes repeated access faster.';
    const call = vi.fn().mockResolvedValue(JSON.stringify({ previews: [{ id: 0, parts: [text] }] }));
    const commit = vi.fn();
    expect(await completeTermPreviews(version(), ['cache'], call, commit)).toEqual([]);
    expect(call).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith({ cache: text });
  });
  it('retains distant term context on long nodes', () => {
    const body = 'Beginning. '.repeat(2000) + 'A [[mutex]] prevents simultaneous access.';
    const request = previewRequest(version(body), ['mutex']);
    expect(request.user).toContain('prevents simultaneous access');
    expect(request.user.length).toBeLessThan(3000);
  });
  it('uses semantic title parts and ignores decorative title changes', () => {
    const v = { ...version(), header: 'Case study: Computing: What changes next? - explained',
      headerParts: { prefix: 'Case study', subject: 'Computing', question: 'What changes next?', suffix: 'explained' } };
    const request = previewRequest(v, ['cache']);
    expect(request.user).toContain('Computing: What changes next?');
    expect(request.user).not.toContain('Case study');
    expect(request.user).not.toContain(' - explained');
    expect(termPreviewFingerprint({ ...v, headerParts: { ...v.headerParts, prefix: 'Example' } }))
      .toBe(termPreviewFingerprint(v));
  });
  it('rejects stale previews after an edit', () => {
    const v = version();
    v.termPreviews = { fingerprint: termPreviewFingerprint(v), entries: { cache: explanation } };
    expect(termPreviewFor(v, 'Cache')).toBe(explanation);
    expect(termPreviewFor({ ...v, body: 'Changed [[cache]].' }, 'cache')).toBeUndefined();
  });
  it('does not reuse stale, differently worded or differently scoped explanations', () => {
    const v = version();
    v.termPreviews = { fingerprint: termPreviewFingerprint(v), entries: { cache: explanation } };
    for (const changed of [
      { ...v, body: 'Changed [[cache]].' }, { ...v, header: 'Biology' },
      { ...v, contentType: 'explain' as const }, { ...v, generatedBy: 'explain' as const },
    ]) expect(reusableTermPreviews(changed, [v])).toBeUndefined();
    const invalid = { ...v, termPreviews: { ...v.termPreviews, fingerprint: 'stale' } };
    expect(reusableTermPreviews({ ...v, termPreviews: undefined }, [invalid])).toBeUndefined();
  });
  it('does not confuse changed literal code with removed term markers', () => {
    const v = version('A [[cache]] example: `[[literal]]`.');
    v.termPreviews = { fingerprint: termPreviewFingerprint(v), entries: { cache: explanation } };
    expect(reusableTermPreviews({ ...v, body: 'A cache example: `literal`.', termPreviews: undefined }, [v])).toBeUndefined();
    expect(reusableTermPreviews({ ...v, body: 'A cache example: `[[literal]]`.', termPreviews: undefined }, [v])?.entries.cache)
      .toBe(explanation);
  });
});

describe('background preview lifecycle', () => {
  beforeEach(() => {
    useSettingsStore.setState({ autoTermPreviews: true });
    seed(); complete.mockReset();
    complete.mockImplementation(async ({ user }) => result(JSON.parse(user).terms.map((term: { id: number }) => term.id)));
    useNodeStatusStore.setState({ statuses: {}, processes: {} });
    useChatRuntimeStore.setState({ views: {}, drafts: {} });
  });
  afterEach(() => { useGraphStore.setState({ project: null, activeProjectId: null }); });
  it('recovers a copy whose source term marking failed and shares the result without new undo steps', async () => {
    const project = seedChat(), ref = { turnId: 'second', versionCreatedAt: 12 };
    useGraphStore.getState().updateNode('n', updateChatAnswer(project.nodes.n!, ref, { body: 'A cache is useful.' }));
    complete.mockRejectedValueOnce(new Error('Offline')).mockRejectedValueOnce(new Error('Offline'));
    await enrichChatAnswer(project.id, 'n', ref, new AbortController().signal);
    expect(chatVersion(12).answerTermMarking?.state).toBe('failed');
    expect(answerEnrichmentError(chatVersion(12))).toContain('Redo terms');
    complete.mockImplementationOnce(async () => '{"terms":["cache"]}');
    useGraphStore.temporal.getState().clear();
    const id = spawnChatAnswer('n', ref)!;
    await vi.waitFor(() => expect(termPreviewFor(useGraphStore.getState().project!.nodes[id]!.versions[0], 'cache')).toBe(explanation));
    expect(chatVersion(12).body).toBe('A [[cache]] is useful.');
    expect(chatVersion(12).answerTermMarking?.state).toBe('complete');
    expect(answerEnrichmentError(chatVersion(12))).toBeUndefined();
    expect(useChatRuntimeStore.getState().views.n?.termErrors?.[12]).toBeUndefined();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(4); // two failures, marking, previews
  });
  it('resumes persisted pending marking after switching away and back, even without the source chat', async () => {
    const project = seedChat(), ref = { turnId: 'second', versionCreatedAt: 12 };
    useGraphStore.getState().updateNode('n', updateChatAnswer(project.nodes.n!, ref, { body: 'A cache is useful.' }));
    complete.mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })));
    const task = enrichChatAnswer(project.id, 'n', ref, new AbortController().signal);
    const id = spawnChatAnswer('n', ref)!;
    const saved = JSON.parse(JSON.stringify(useGraphStore.getState().project!));
    delete saved.nodes.n;
    saved.selection = [id]; saved.rootNodeId = id;
    useGraphStore.setState({ project: null, activeProjectId: null });
    await task;
    expect(saved.nodes[id].versions[0].answerTermMarking.state).toBe('pending');
    complete.mockImplementationOnce(async () => '{"terms":["cache"]}');
    useGraphStore.setState({ project: saved, activeProjectId: saved.id });
    const stop = watchFocusedTermPreviews();
    try {
      await vi.waitFor(() => expect(termPreviewFor(useGraphStore.getState().project!.nodes[id]!.versions[0], 'cache')).toBe(explanation));
      expect(complete).toHaveBeenCalledTimes(3);
    } finally { stop(); }
  });
  it('records a valid empty term selection as complete instead of repeatedly spending tokens on it', async () => {
    const project = seedChat(), ref = { turnId: 'second', versionCreatedAt: 12 };
    useGraphStore.getState().updateNode('n', updateChatAnswer(project.nodes.n!, ref, { body: 'Thank you.' }));
    complete.mockResolvedValue('{"terms":[]}');
    await ensureAnswerTerms(project.id, 'n', ref);
    await ensureAnswerTerms(project.id, 'n', ref);
    spawnChatAnswer('n', ref);
    expect(complete).toHaveBeenCalledOnce();
    expect(chatVersion(12).answerTermMarking?.state).toBe('complete');
  });
  it('manual retry clears exhausted preview failures but retains completed entries', async () => {
    seedChat();
    const node = useGraphStore.getState().project!.nodes.n!;
    useGraphStore.getState().updateNode('n', updateChatAnswer(node, { turnId: 'second', versionCreatedAt: 12 },
      { body: 'A [[cache]] reduces [[latency]].' }));
    complete.mockResolvedValue('{"previews":[]}').mockResolvedValueOnce(result([0]));
    await generateTermPreviews('n', 12);
    expect(answerEnrichmentError(chatVersion(12))).toContain('Some term previews');
    complete.mockReset();
    complete.mockResolvedValue(result([0])).mockResolvedValueOnce('{"terms":["cache","latency"]}');
    await redoChatTerms('n', { turnId: 'second', versionCreatedAt: 12 });
    await vi.waitFor(() => expect(termPreviewFor(chatVersion(12), 'latency')).toBe(explanation));
    expect(termPreviewFor(chatVersion(12), 'cache')).toBe(explanation);
    expect(JSON.parse(complete.mock.calls[1]![0].user).terms).toEqual([{ id: 0, term: 'latency' }]);
    expect(answerEnrichmentError(chatVersion(12))).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it.each(['encyclopedic', 'explain', 'answer', 'chat'] as const)('redo recovers abbreviated-name previews in %s without regenerating completed entries', async contentType => {
    seed('A [[cache]] stores a recording by [[Aphex Twin]].');
    if (contentType === 'chat') {
      const project = seedChat();
      useGraphStore.getState().updateNode('n', updateChatAnswer(project.nodes.n!, { turnId: 'second', versionCreatedAt: 12 },
        { body: 'A [[cache]] stores a recording by [[Aphex Twin]].' }));
    } else useGraphStore.getState().updateNode('n', { versions: [{ ...current(), contentType }] });
    const node = useGraphStore.getState().project!.nodes.n!;
    const timestamp = contentType === 'chat' ? 12 : 10;
    useGraphStore.getState().updateNode('n', { versions: node.versions.map(v => v.createdAt === timestamp ? { ...v,
      termPreviews: { fingerprint: termPreviewFingerprint(v), entries: { cache: explanation }, exhaustedTerms: ['aphex twin'] },
    } : v) });
    const abbreviated = ['Aphex Twin is the alias of ', 'Richard D. James', ', a musician known for ', 'experimental electronic music', '.'];
    const expected = 'Aphex Twin is the alias of **Richard D. James**, a musician known for **experimental electronic music**.';
    complete.mockResolvedValueOnce('{"terms":["cache","Aphex Twin"]}')
      .mockResolvedValue(JSON.stringify({ previews: [{ id: 0, parts: abbreviated }] }));
    if (contentType === 'chat') await redoChatTerms('n', { turnId: 'second', versionCreatedAt: 12 });
    else await redoTermMarking('n');
    const latest = () => contentType === 'chat' ? chatVersion(12) : useGraphStore.getState().project!.nodes.n!.versions.at(-1)!;
    await vi.waitFor(() => expect(termPreviewFor(latest(), 'Aphex Twin')).toBe(expected));
    expect(termPreviewFor(latest(), 'cache')).toBe(explanation);
    expect(answerEnrichmentError(latest())).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(2); // marking + one preview; no repairs
    expect(JSON.parse(complete.mock.calls[1]![0].user).terms).toEqual([{ id: 0, term: 'Aphex Twin' }]);
    await generateTermPreviews('n', latest().createdAt);
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it.each(['generating', 'failed'] as const)('redo previews for a completed answer are independent of another chat turn being %s', async (state) => {
    const project = seedChat();
    const ref = { turnId: 'first', versionCreatedAt: 11 };
    useGraphStore.getState().updateNode('n', {
      ...updateChatAnswer(project.nodes.n!, { turnId: 'second', versionCreatedAt: 12 }, {},
        { state: state === 'generating' ? 'generating' : 'interrupted' }),
      generating: state === 'generating',
      generationError: state === 'failed' ? 'Another answer failed' : undefined,
    });
    complete.mockResolvedValueOnce('{"terms":["cache"]}');
    await redoChatTerms('n', ref);
    await vi.waitFor(() => expect(termPreviewFor(chatVersion(11), 'cache')).toBe(explanation));
    expect(chatVersion(12).termPreviews).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it.each(['encyclopedic', 'explain', 'answer', 'chat'] as const)('redo retries failed %s previews without inheriting failures from older versions', async (contentType) => {
    seed('A [[cache]] reduces [[latency]].');
    const initial = { ...current(), contentType, wikimediaImages: {
      schemaVersion: 1 as const, bodyFingerprint: '', providerId: 'test', model: 'test', searchedAt: 0, resultLimit: 0, results: [],
    } };
    if (contentType === 'chat') {
      seedChat();
      const node = useGraphStore.getState().project!.nodes.n!;
      useGraphStore.getState().updateNode('n', updateChatAnswer(node, { turnId: 'second', versionCreatedAt: 12 }, { body: initial.body }));
    } else useGraphStore.getState().updateNode('n', { versions: [initial] });
    const timestamp = contentType === 'chat' ? 12 : 10;
    complete.mockResolvedValue('{"previews":[]}').mockResolvedValueOnce(result([0]));
    await generateTermPreviews('n', timestamp);
    // A matching historical alternative must not make an explicit retry inherit its failure.
    const node = useGraphStore.getState().project!.nodes.n!;
    const failed = node.versions.find(v => v.createdAt === timestamp)!;
    expect(failed.termPreviews?.exhaustedTerms).toEqual(['latency']);
    useGraphStore.getState().updateNode('n', { versions: [...node.versions, { ...failed, createdAt: 13, answerEnrichmentId: undefined,
      termPreviews: { ...failed.termPreviews!, fingerprint: termPreviewFingerprint({ ...failed, answerEnrichmentId: undefined }) } }] });
    complete.mockReset();
    complete.mockResolvedValue(result([0])).mockResolvedValueOnce('{"terms":["cache","latency"]}');
    if (contentType === 'chat') await redoChatTerms('n', { turnId: 'second', versionCreatedAt: 12 });
    else await redoTermMarking('n');
    const latest = () => contentType === 'chat' ? chatVersion(12) : useGraphStore.getState().project!.nodes.n!.versions.at(-1)!;
    await vi.waitFor(() => expect(termPreviewFor(latest(), 'latency')).toBe(explanation));
    expect(termPreviewFor(latest(), 'cache')).toBe(explanation);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.parse(complete.mock.calls[1]![0].user).terms).toEqual([{ id: 0, term: 'latency' }]);
    await generateTermPreviews('n', latest().createdAt);
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('persists an actionable preview network error and clears it after successful recovery', async () => {
    seedChat();
    complete.mockRejectedValueOnce(new Error('Network unavailable'));
    await generateTermPreviews('n', 12);
    expect(answerEnrichmentError(chatVersion(12))).toContain('could not finish');
    await generateTermPreviews('n', 12);
    expect(answerEnrichmentError(chatVersion(12))).toBeUndefined();
    expect(termPreviewFor(chatVersion(12), 'cache')).toBe(explanation);
  });
  it('copies completed previews despite a different title and content type without any request', async () => {
    seedChat();
    await generateTermPreviews('n', 12);
    complete.mockClear();
    const id = spawnChatAnswer('n', { turnId: 'second', versionCreatedAt: 12 })!;
    await generateTermPreviews(id, 12);
    expect(termPreviewFor(useGraphStore.getState().project!.nodes[id]!.versions[0], 'cache')).toBe(explanation);
    expect(complete).not.toHaveBeenCalled();
  });
  it.each([false, true])('one pending preview request serves the source and multiple copies (source deleted: %s)', async (deleted) => {
    seedChat();
    let resolve!: (value: string) => void;
    complete.mockReturnValueOnce(new Promise<string>(r => { resolve = r; }));
    const task = generateTermPreviews('n', 12);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const first = spawnChatAnswer('n', { turnId: 'second', versionCreatedAt: 12 })!;
    const second = spawnChatAnswer('n', { turnId: 'second', versionCreatedAt: 12 })!;
    await generateTermPreviews(first, 12);
    await generateTermPreviews(second, 12);
    expect(useNodeStatusStore.getState().processes[first]?.[termPreviewProcess(12)]?.clearedAt).toBeNull();
    if (deleted) {
      const p = useGraphStore.getState().project!;
      const { n: _n, ...nodes } = p.nodes;
      useGraphStore.setState({ project: { ...p, nodes } });
    }
    resolve(result([0])); await task;
    for (const id of [first, second]) expect(termPreviewFor(useGraphStore.getState().project!.nodes[id]!.versions[0], 'cache')).toBe(explanation);
    expect(complete).toHaveBeenCalledOnce();
  });
  it.each([false, true])('term marking started before spawning uses one shared preview request (source deleted: %s)', async (deleted) => {
    const project = seedChat();
    const node = project.nodes.n!;
    useGraphStore.getState().updateNode('n', updateChatAnswer(node, { turnId: 'second', versionCreatedAt: 12 }, { body: 'A cache is useful.' }));
    let resolve!: (value: string) => void;
    complete.mockReturnValueOnce(new Promise<string>(r => { resolve = r; }));
    const task = enrichChatAnswer(project.id, 'n', { turnId: 'second', versionCreatedAt: 12 }, new AbortController().signal);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const id = spawnChatAnswer('n', { turnId: 'second', versionCreatedAt: 12 })!;
    await generateTermPreviews(id, 12);
    expect(complete).toHaveBeenCalledOnce();
    if (deleted) {
      const p = useGraphStore.getState().project!;
      const { n: _n, ...nodes } = p.nodes;
      useGraphStore.setState({ project: { ...p, nodes } });
    }
    resolve('{"terms":["cache"]}'); await task;
    await vi.waitFor(() => expect(termPreviewFor(useGraphStore.getState().project!.nodes[id]!.versions[0], 'cache')).toBe(explanation));
    expect(useGraphStore.getState().project!.nodes[id]!.versions[0]!.body).toBe('A [[cache]] is useful.');
    if (!deleted) expect(termPreviewFor(chatVersion(12), 'cache')).toBe(explanation);
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('explicitly re-marking an answer detaches it without changing its existing copies', async () => {
    seedChat();
    const node = useGraphStore.getState().project!.nodes.n!;
    useGraphStore.getState().updateNode('n', updateChatAnswer(node,
      { turnId: 'second', versionCreatedAt: 12 }, { body: 'A [[cache]] improves latency.' }));
    await generateTermPreviews('n', 12);
    const id = spawnChatAnswer('n', { turnId: 'second', versionCreatedAt: 12 })!;
    const copied = useGraphStore.getState().project!.nodes[id]!.versions[0]!;
    complete.mockClear();
    complete.mockImplementationOnce(async () => '{"terms":["cache","latency"]}');
    await redoChatTerms('n', { turnId: 'second', versionCreatedAt: 12 });
    await vi.waitFor(() => expect(termPreviewFor(chatVersion(12), 'latency')).toBe(explanation));
    expect(chatVersion(12).answerEnrichmentId).not.toBe(copied.answerEnrichmentId);
    expect(useGraphStore.getState().project!.nodes[id]!.versions[0]).toBe(copied);
    expect(termPreviewFor(copied, 'cache')).toBe(explanation);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.parse(complete.mock.calls[1]![0].user).terms).toEqual([{ id: 0, term: 'latency' }]);
  });
  it('manual editing detaches the working version from pending shared results', async () => {
    seedChat();
    let resolve!: (value: string) => void;
    complete.mockReturnValueOnce(new Promise<string>(r => { resolve = r; }));
    const task = generateTermPreviews('n', 12);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const id = spawnChatAnswer('n', { turnId: 'second', versionCreatedAt: 12 })!;
    saveManualEdit(id, 'Edited', 'A different [[cache]] context.');
    resolve(result([0])); await task;
    const node = useGraphStore.getState().project!.nodes[id]!;
    expect(node.versions[node.currentVersionIndex]).toMatchObject({ body: 'A different [[cache]] context.' });
    expect(node.versions[node.currentVersionIndex]?.answerEnrichmentId).toBeUndefined();
    expect(termPreviewFor(node.versions[node.currentVersionIndex], 'cache')).toBeUndefined();
    expect(termPreviewFor(chatVersion(12), 'cache')).toBe(explanation);
  });
  it('fills matching restored history entries without overwriting an earlier cache commit', async () => {
    seedChat();
    const original = chatVersion(12);
    const shared = { ...original, answerEnrichmentId: 'restored-answer' };
    useGraphStore.getState().updateNode('n', { versions: [shared, { ...shared, createdAt: 13 }], currentVersionIndex: 0 });
    await generateTermPreviews('n', 12);
    for (const v of useGraphStore.getState().project!.nodes.n!.versions) expect(termPreviewFor(v, 'cache')).toBe(explanation);
    expect(complete).toHaveBeenCalledOnce();
  });
  it('persists metadata without changing the body or adding undo entries, and reuses it', async () => {
    const body = current().body;
    await generateTermPreviews('n', 10);
    expect(termPreviewFor(current(), 'cache')).toBe(explanation);
    expect(current().body).toBe(body);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    expect(useNodeStatusStore.getState().processes.n?.[termPreviewProcess(10)]?.clearedAt).not.toBeNull();
    await generateTermPreviews('n', 10);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it.each(['encyclopedic', 'explain', 'answer'] as const)('reuses previews through re-marking %s nodes, generating only new terms', async (contentType) => {
    seed('A **[[cache]]** improves latency.');
    const initial: NodeVersion = { ...current(), contentType, wikimediaImages: {
      schemaVersion: 1, bodyFingerprint: '', providerId: 'test', model: 'test', searchedAt: 0, resultLimit: 0, results: [],
    } };
    useGraphStore.getState().updateNode('n', { versions: [initial] });
    await generateTermPreviews('n', 10);
    complete.mockClear();
    complete.mockImplementationOnce(async () => '{"terms":["cache","latency"]}');
    useGraphStore.temporal.getState().clear();
    await redoTermMarking('n');
    const latest = () => useGraphStore.getState().project!.nodes.n!.versions.at(-1)!;
    await vi.waitFor(() => expect(termPreviewFor(latest(), 'latency')).toBe(explanation));
    expect(termPreviewFor(latest(), 'cache')).toBe(explanation);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.parse(complete.mock.calls[1]![0].user).terms).toEqual([{ id: 0, term: 'latency' }]);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(current().body).toBe(initial.body);
    expect(termPreviewFor(current(), 'cache')).toBe(explanation);
  });
  it('reuses chat previews received during re-marking and only requests newly marked terms', async () => {
    const project = seedChat();
    useGraphStore.getState().updateNode('n', updateChatAnswer(project.nodes.n,
      { turnId: 'second', versionCreatedAt: 12 }, { body: 'A **[[cache]]** improves latency.' }));
    complete.mockImplementationOnce(async () => {
      // A preview finishes while the term-selection request is in flight.
      const node = useGraphStore.getState().project!.nodes.n!;
      const v = chatVersion(12);
      useGraphStore.getState().updateNode('n', updateChatAnswer(node,
        { turnId: 'second', versionCreatedAt: 12 }, { termPreviews: {
          fingerprint: termPreviewFingerprint(v), entries: { cache: explanation },
        } }));
      return '{"terms":["cache","latency"]}';
    });
    await redoChatTerms('n', { turnId: 'second', versionCreatedAt: 12 });
    await vi.waitFor(() => expect(termPreviewFor(chatVersion(12), 'latency')).toBe(explanation));
    expect(termPreviewFor(chatVersion(12), 'Cache')).toBe(explanation);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.parse(complete.mock.calls[1]![0].user).terms).toEqual([{ id: 0, term: 'latency' }]);
  });
  it('recovers previews from matching older versions without additional requests', async () => {
    seed('A [[cache]] improves [[latency]].');
    await generateTermPreviews('n', 10);
    const saved = current();
    const withoutCache = { ...saved, createdAt: 11, body: 'A cache improves [[latency]].', termPreviews: undefined };
    const remarked = { ...saved, createdAt: 12, body: 'A [[cache]] improves latency.', termPreviews: undefined };
    useGraphStore.getState().updateNode('n', { versions: [saved, withoutCache, remarked], currentVersionIndex: 2 });
    await generateTermPreviews('n', 12);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(termPreviewFor(useGraphStore.getState().project!.nodes.n!.versions[2], 'cache')).toBe(explanation);
  });
  it('does not request previews again when chat re-marking leaves the same terms', async () => {
    seedChat();
    await generateTermPreviews('n', 12);
    complete.mockClear();
    complete.mockImplementationOnce(async () => '{"terms":["cache"]}');
    await redoChatTerms('n', { turnId: 'second', versionCreatedAt: 12 });
    expect(termPreviewFor(chatVersion(12), 'cache')).toBe(explanation);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('deduplicates pending work and uses the independent ASCII status lane', async () => {
    let resolve!: (value: string) => void;
    complete.mockReturnValue(new Promise<string>(r => { resolve = r; }));
    const pending = generateTermPreviews('n', 10);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(useNodeStatusStore.getState().processes.n?.[termPreviewProcess(10)]?.text).toBe('GENERATING TERM PREVIEWS');
    await generateTermPreviews('n', 10);
    resolve(result([0])); await pending;
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('starts a fresh request when the previous request for the same text was already cancelled', async () => {
    let finishOld!: (value: string) => void;
    complete.mockReturnValueOnce(new Promise<string>(resolve => { finishOld = resolve; }));
    const old = generateTermPreviews('n', 10);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    useSettingsStore.setState({ autoTermPreviews: false });
    expect(complete.mock.calls[0]![0].signal.aborted).toBe(true);
    useSettingsStore.setState({ autoTermPreviews: true });
    // The cancelled provider request has not settled yet. Its registry entry
    // must not suppress this retry just because the answer has not changed.
    const retry = generateTermPreviews('n', 10);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    finishOld(result([0]));
    await Promise.all([old, retry]);
    expect(termPreviewFor(current(), 'cache')).toBe(explanation);
  });
  it('explicit re-marking still respects the automatic-preview preference', async () => {
    seedChat();
    useSettingsStore.setState({ autoTermPreviews: false });
    complete.mockResolvedValueOnce('{"terms":["cache"]}');
    await redoChatTerms('n', { turnId: 'second', versionCreatedAt: 12 });
    expect(complete).toHaveBeenCalledOnce();
    expect(chatVersion(12).termPreviews?.entries ?? {}).toEqual({});
  });
  it('a cancelled shared preview cannot clear the replacement redo status', async () => {
    seedChat();
    let finishOld!: (value: string) => void, finishNew!: (value: string) => void;
    complete.mockReturnValueOnce(new Promise<string>(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce('{"terms":["cache"]}')
      .mockReturnValueOnce(new Promise<string>(resolve => { finishNew = resolve; }));
    const old = generateTermPreviews('n', 12);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await redoChatTerms('n', { turnId: 'second', versionCreatedAt: 12 });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3));
    finishOld(result([0])); await old;
    expect(useNodeStatusStore.getState().processes.n?.[termPreviewProcess(12)]?.clearedAt).toBeNull();
    finishNew(result([0]));
    await vi.waitFor(() => expect(termPreviewFor(chatVersion(12), 'cache')).toBe(explanation));
  });
  it('splits large lists and retries only rejected entries once', async () => {
    seed(Array.from({ length: 26 }, (_, i) => `[[term ${i}]]`).join(' '));
    complete.mockImplementationOnce(async () => result(Array.from({ length: 23 }, (_, i) => i)));
    await generateTermPreviews('n', 10);
    expect(complete.mock.calls.map(([options]) => JSON.parse(options.user).terms.length)).toEqual([24, 1, 2]);
    expect(Object.keys(current().termPreviews!.entries)).toHaveLength(26);
  });
  it('uses single-term repair only after a smaller group fails, with a strict retry limit', async () => {
    complete.mockResolvedValue('{"previews":[]}');
    await generateTermPreviews('n', 10);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(current().termPreviews?.exhaustedTerms).toEqual(['cache']);
    const cleared = useNodeStatusStore.getState().processes.n?.[termPreviewProcess(10)];
    await generateTermPreviews('n', 10);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(useNodeStatusStore.getState().processes.n?.[termPreviewProcess(10)]).toBe(cleared);
  });
  it('does not request or show generation status while disabled, and backfills when enabled', async () => {
    useSettingsStore.setState({ autoTermPreviews: false });
    const stop = watchFocusedTermPreviews();
    try {
      await generateTermPreviews('n', 10);
      await Promise.resolve();
      expect(complete).not.toHaveBeenCalled();
      expect(useNodeStatusStore.getState().processes).toEqual({});
      useSettingsStore.setState({ autoTermPreviews: true });
      await vi.waitFor(() => expect(termPreviewFor(current(), 'cache')).toBe(explanation));
    } finally { stop(); }
  });
  it('cancels in-flight previews when automatic generation is disabled', async () => {
    let resolve!: (value: string) => void;
    complete.mockReturnValue(new Promise<string>(r => { resolve = r; }));
    const pending = generateTermPreviews('n', 10);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    useSettingsStore.setState({ autoTermPreviews: false });
    expect(complete.mock.calls[0]![0].signal.aborted).toBe(true);
    resolve(result([0])); await pending;
    expect(current().termPreviews).toBeUndefined();
    expect(useNodeStatusStore.getState().processes.n?.[termPreviewProcess(10)]?.clearedAt).not.toBeNull();
  });
  it('does not restart status after focusing a fully or partially completed node again', async () => {
    seed('A [[cache]] improves [[latency]].');
    complete.mockResolvedValue('{"previews":[]}').mockResolvedValueOnce(result([0]));
    await generateTermPreviews('n', 10);
    expect(current().termPreviews?.entries.cache).toBe(explanation);
    expect(current().termPreviews?.exhaustedTerms).toEqual(['latency']);
    complete.mockClear();
    useNodeStatusStore.setState({ processes: {} });
    const stop = watchFocusedTermPreviews();
    try {
      await Promise.resolve();
      useGraphStore.getState().setSelection([]); await Promise.resolve();
      useGraphStore.getState().setSelection(['n']); await Promise.resolve();
      expect(complete).not.toHaveBeenCalled();
      expect(useNodeStatusStore.getState().processes).toEqual({});
      useGraphStore.getState().updateNode('n', { versions: [version('Changed [[latency]].')] });
      await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    } finally { stop(); }
  });
  it.each(['edit', 'delete', 'switch'] as const)('discards late results after %s', async (action) => {
    let resolve!: (value: string) => void;
    complete.mockReturnValue(new Promise<string>(r => { resolve = r; }));
    const pending = generateTermPreviews('n', 10);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    if (action === 'edit') useGraphStore.getState().updateNode('n', { versions: [version('Changed [[cache]].')] });
    if (action === 'delete') useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, nodes: {} });
    if (action === 'switch') useGraphStore.getState().setProject(createBlankProject('Different', 'other'));
    expect(complete.mock.calls[0]![0].signal.aborted).toBe(true);
    resolve(result([0])); await pending;
    expect(useGraphStore.getState().project?.nodes.n?.versions[0]?.termPreviews).toBeUndefined();
  });
  it('enriches legacy focused nodes without requesting again for metadata-only updates', async () => {
    const stop = watchFocusedTermPreviews();
    await vi.waitFor(() => expect(current().termPreviews).toBeDefined());
    useGraphStore.getState().updateNode('n', { frozen: true });
    expect(complete).toHaveBeenCalledTimes(1);
    stop();
  });
  it.each(['explain', undefined] as const)('backfills explain previews on focus and reuses them after refocusing (content type: %s)', async (contentType) => {
    useGraphStore.getState().updateNode('n', { type: 'explain', versions: [{ ...current(),
      header: 'Computing explained', headerParts: { subject: 'Computing', suffix: 'explained' },
      body: 'A **[[cache]]** holds recent results. This reduces [[latency]].', generatedBy: 'explain', contentType,
    }] });
    useGraphStore.temporal.getState().clear();
    useGraphStore.getState().setSelection([]);
    const stop = watchFocusedTermPreviews();
    try {
      await Promise.resolve();
      expect(complete).not.toHaveBeenCalled();
      useGraphStore.getState().setSelection(['n']);
      await vi.waitFor(() => {
        expect(termPreviewFor(current(), 'cache')).toBe(explanation);
        expect(termPreviewFor(current(), 'latency')).toBe(explanation);
      });
      expect(complete).toHaveBeenCalledTimes(1);
      useNodeStatusStore.setState({ processes: {} });
      useGraphStore.getState().setSelection([]); await Promise.resolve();
      useGraphStore.getState().setSelection(['n']); await Promise.resolve();
      expect(complete).toHaveBeenCalledTimes(1);
      expect(useNodeStatusStore.getState().processes).toEqual({});
      expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    } finally { stop(); }
  });
  it('waits for explain-node streaming to finish before generating previews', async () => {
    useGraphStore.getState().updateNode('n', { type: 'explain', generating: true,
      versions: [{ ...current(), generatedBy: 'explain', contentType: 'explain' }] });
    const stop = watchFocusedTermPreviews();
    try {
      await Promise.resolve();
      expect(complete).not.toHaveBeenCalled();
      useGraphStore.getState().updateNode('n', { generating: false });
      await vi.waitFor(() => expect(termPreviewFor(current(), 'cache')).toBe(explanation));
      expect(complete).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });
  it('generates chat previews automatically after marking terms, without changing the answer or adding undo', async () => {
    const project = seedChat();
    const node = project.nodes.n;
    useGraphStore.getState().updateNode('n', updateChatAnswer(node, { turnId: 'second', versionCreatedAt: 12 }, { body: 'A **cache** helps.' }));
    useGraphStore.temporal.getState().clear();
    complete.mockImplementationOnce(async () => '{"terms":["cache"]}');
    await enrichChatAnswer(project.id, 'n', { turnId: 'second', versionCreatedAt: 12 }, new AbortController().signal);
    await vi.waitFor(() => expect(termPreviewFor(chatVersion(12), 'cache')).toBe(explanation));
    expect(chatVersion(12).body).toBe('A **[[cache]]** helps.');
    expect(chatVersion(10).termPreviews).toBeUndefined();
    expect(chatVersion(11).termPreviews).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });
  it('backfills visible answers on focus, then historical alternatives when viewed, without repeat requests', async () => {
    seedChat();
    const stop = watchFocusedTermPreviews();
    try {
      await vi.waitFor(() => {
        expect(termPreviewFor(chatVersion(11), 'cache')).toBe(explanation);
        expect(termPreviewFor(chatVersion(12), 'cache')).toBe(explanation);
      });
      expect(chatVersion(10).termPreviews).toBeUndefined();
      expect(complete).toHaveBeenCalledTimes(2);
      useChatRuntimeStore.getState().view('n', { previews: { first: 10 } });
      await vi.waitFor(() => expect(termPreviewFor(chatVersion(10), 'cache')).toBe(explanation));
      expect(complete).toHaveBeenCalledTimes(3);
      useChatRuntimeStore.getState().view('n', { scrollTop: 200, previews: {} });
      useGraphStore.getState().setSelection([]);
      await Promise.resolve();
      useGraphStore.getState().setSelection(['n']);
      await Promise.resolve();
      expect(complete).toHaveBeenCalledTimes(3);
      expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    } finally { stop(); }
  });
  it('skips streaming chat answers and fills in their previews once completed', async () => {
    const project = seedChat();
    const node = project.nodes.n;
    useGraphStore.getState().updateNode('n', {
      ...updateChatAnswer(node, { turnId: 'second', versionCreatedAt: 12 }, {}, { state: 'generating' }), generating: true,
    });
    await generateTermPreviews('n', 12);
    expect(complete).not.toHaveBeenCalled();
    const stop = watchFocusedTermPreviews();
    try {
      await Promise.resolve();
      expect(complete).not.toHaveBeenCalled();
      const currentNode = useGraphStore.getState().project!.nodes.n!;
      useGraphStore.getState().updateNode('n', {
        ...updateChatAnswer(currentNode, { turnId: 'second', versionCreatedAt: 12 }, {}, { state: 'complete' }), generating: false,
      });
      await vi.waitFor(() => expect(termPreviewFor(chatVersion(12), 'cache')).toBe(explanation));
    } finally { stop(); }
  });
  it('keeps good partial results after a failed call; no retry storm', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seed(Array.from({ length: 26 }, (_, i) => `[[term ${i}]]`).join(' '));
    complete.mockImplementationOnce(async ({ user }) => result(JSON.parse(user).terms.map((t: { id: number }) => t.id)))
      .mockRejectedValueOnce(new Error('Provider unavailable'));
    await generateTermPreviews('n', 10);
    expect(Object.keys(current().termPreviews!.entries)).toHaveLength(24);
    expect(complete).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
