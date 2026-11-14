import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { NodeTextSelection } from '@/store/useNodeTextSelectionStore';
import { LANGUAGES } from './languages';
import { markSelectedTerm, stripTermMarkers } from './termMarking';
import { markTermFromSelection } from './manualTerms';
import { termPreviewFingerprint, termPreviewFor } from './termPreviewCore';
import { watchFocusedTermPreviews, termPreviewProcess } from './termPreviews';
import { createArrowSourceSelection, resolveArrowSourceSelection } from './sourceSelection';

const complete = vi.hoisted(() => vi.fn());
vi.mock('./secondaryTaskCompletion', () => ({ secondaryTaskCompletion: complete }));
const current = () => useGraphStore.getState().project!.nodes.n!.versions[0]!;
function selection(body: string, text: string, start = body.indexOf(text)): NodeTextSelection {
  return { nodeId: 'n', versionIndex: 0, sourceBody: body, start, end: start + text.length, text,
    parts: [{ sourceField: 'ft', start, end: start + text.length, text }] };
}
function seed(body = 'A [[cache]] uses memory and storage. Memory can be reused.') {
  const project = createBlankProject('Manual terms', 'n');
  project.nodes.n = { id: 'n', type: 'explain', frozen: false, position: { x: 0, y: 0 }, currentVersionIndex: 0,
    versions: [{ header: 'Memory', body, createdAt: 1, generatedBy: 'explain', contentType: 'explain', language: 'de' }] };
  project.selection = ['n'];
  useGraphStore.setState({ project, activeProjectId: project.id });
  useGraphStore.temporal.getState().clear();
  return project.id;
}
const response = (term: string) => JSON.stringify({ previews: [{ id: 0, parts: [`A ${term} explanation.`] }] });

describe('selected occurrence marking', () => {
  it('marks only the selected repetition', () => {
    const body = 'memory and memory';
    expect(markSelectedTerm(selection(body, 'memory', 11))?.body).toBe('memory and [[memory]]');
  });
  it('leaves incidental selected whitespace outside the term', () => {
    expect(markSelectedTerm({ ...selection('A memory here.', 'memory'), start: 1, end: 9 })?.body)
      .toBe('A [[memory]] here.');
  });
  it.each(['**memory** and storage', '**memory and storage**', 'memory and *storage*'])('retains balanced emphasis in %s', body => {
    const result = markSelectedTerm(selection(body, 'memory'));
    expect(result).not.toBeNull();
    expect(stripTermMarkers(result!.body)).toBe(body);
  });
  it.each(['`memory`', '[memory](https://example.test)', '[[memory]]', '$memory$', 'memorycell'])('protects code, links, math, existing terms and word boundaries: %s', body => {
    expect(markSelectedTerm(selection(body, 'memory'))).toBeNull();
  });
  it('does not wrap multiple fields, multiline text, or implicit whole terms', () => {
    const selected = selection('memory and storage', 'memory');
    expect(markSelectedTerm({ ...selected, parts: [...selected.parts!, ...selected.parts!] })).toBeNull();
    expect(markSelectedTerm({ ...selected, parts: [{ ...selected.parts![0]!, sourceField: 'b:0:c:0:name' }] })).toBeNull();
    expect(markSelectedTerm(selection('memory\nand storage', 'memory\nand'))).toBeNull();
  });
  const words = ['Erklärung', 'mémoire', 'español', 'conexão', 'pamięć', 'geheugen', 'minne', 'hukommelse', 'muisti', 'minne', 'paměť', 'μνήμη', 'память', 'ذاكرة', 'स्मृति', '記憶', '记忆', '기억', 'bellek', 'memory'];
  it.each(LANGUAGES.map((language, index) => [language.id, words[index]!] as const))('preserves the source bytes and selected term for %s', (_language, word) => {
    const body = `Topic: ${word}.`;
    expect(markSelectedTerm(selection(body, word))).toMatchObject({ body: `Topic: [[${word}]].`, term: word });
  });
});

describe('manual term background previews', () => {
  beforeEach(() => {
    seed();
    useSettingsStore.setState({ autoTermPreviews: true });
    useNodeStatusStore.setState({ statuses: {}, processes: {} });
    complete.mockReset();
    complete.mockImplementation(async ({ user }) => response(JSON.parse(user).terms[0].term));
  });
  afterEach(() => useGraphStore.setState({ project: null, activeProjectId: null }));
  it.each([true, false])('requests only the new term, retains old previews and adds one undo entry (auto %s)', async enabled => {
    useSettingsStore.setState({ autoTermPreviews: enabled });
    const source = current();
    source.termPreviews = { fingerprint: termPreviewFingerprint(source), entries: { cache: 'A paid preview.' }, exhaustedTerms: ['other'] };
    const projectId = useGraphStore.getState().project!.id;
    const stop = watchFocusedTermPreviews();
    try {
      expect(markTermFromSelection(projectId, selection(source.body, 'memory'))).toBe(true);
      await vi.waitFor(() => expect(termPreviewFor(current(), 'memory')).toBe('A memory explanation.'));
      expect(complete).toHaveBeenCalledOnce();
      expect(JSON.parse(complete.mock.calls[0]![0].user).terms).toEqual([{ id: 0, term: 'memory' }]);
      expect(termPreviewFor(current(), 'cache')).toBe('A paid preview.');
      expect(current().termPreviews?.exhaustedTerms).toEqual(['other']);
      expect(current().language).toBe('de');
      expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
      useGraphStore.temporal.getState().undo();
      expect(current().body).toBe(source.body);
      expect(termPreviewFor(current(), 'memory')).toBeUndefined();
    } finally { stop(); }
  });
  it('does not automatically request other uncached terms on the manual mutation', async () => {
    const stop = watchFocusedTermPreviews();
    try {
      expect(markTermFromSelection(useGraphStore.getState().project!.id, selection(current().body, 'memory'))).toBe(true);
      await vi.waitFor(() => expect(termPreviewFor(current(), 'memory')).toBeTruthy());
      expect(complete).toHaveBeenCalledOnce();
      expect(termPreviewFor(current(), 'cache')).toBeUndefined();
    } finally { stop(); }
  });
  it('preserves the exact repeated occurrence of existing source links and undoes both edits together', async () => {
    const projectId = seed('memory and storage; storage again.');
    const source = current().body;
    const anchor = createArrowSourceSelection(selection(source, 'storage', source.lastIndexOf('storage')), 1)!;
    useGraphStore.getState().addArrow({ id: 'linked', kind: 'auto', fromNodeId: 'n', toNodeId: 'child', sourceSelection: anchor });
    useGraphStore.temporal.getState().clear();
    markTermFromSelection(projectId, selection(source, 'memory'));
    const shifted = useGraphStore.getState().project!.arrows.linked!.sourceSelection!;
    expect(shifted.parts[0]!.start).toBe(anchor.parts[0]!.start + 4);
    expect(resolveArrowSourceSelection(current().body, 1, shifted)?.parts[0]).toMatchObject({ displayStart: source.lastIndexOf('storage'), text: 'storage' });
    await vi.waitFor(() => expect(termPreviewFor(current(), 'memory')).toBeTruthy());
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(current().body).toBe(source);
    expect(useGraphStore.getState().project!.arrows.linked!.sourceSelection).toEqual(anchor);
  });
  it('runs two independent jobs, merges out of order and keeps status until both finish', async () => {
    const finishes: Array<(value: string) => void> = [];
    complete.mockImplementation(() => new Promise<string>(resolve => finishes.push(resolve)));
    const projectId = useGraphStore.getState().project!.id;
    const stop = watchFocusedTermPreviews();
    try {
      markTermFromSelection(projectId, selection(current().body, 'memory'));
      await vi.waitFor(() => expect(finishes).toHaveLength(1));
      markTermFromSelection(projectId, selection(current().body, 'storage'));
      await vi.waitFor(() => expect(finishes).toHaveLength(2));
      expect(complete.mock.calls.every(([request]) => !request.signal.aborted)).toBe(true);
      finishes[1]!(response('storage'));
      await vi.waitFor(() => expect(termPreviewFor(current(), 'storage')).toBeTruthy());
      expect(useNodeStatusStore.getState().processes.n![termPreviewProcess(1)]!.clearedAt).toBeNull();
      finishes[0]!(response('memory'));
      await vi.waitFor(() => expect(termPreviewFor(current(), 'memory')).toBeTruthy());
      await vi.waitFor(() => expect(useNodeStatusStore.getState().processes.n![termPreviewProcess(1)]!.clearedAt).not.toBeNull());
      expect(termPreviewFor(current(), 'storage')).toBe('A storage explanation.');
      expect(complete).toHaveBeenCalledTimes(2);
      expect(useGraphStore.temporal.getState().pastStates).toHaveLength(2);
    } finally { finishes.forEach(finish => finish(response('memory'))); stop(); }
  });
  it('keeps a failed term actionable when a parallel request succeeds and retries only that term', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail!: (error: Error) => void, finish!: (value: string) => void;
    complete.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    try {
      const projectId = useGraphStore.getState().project!.id;
      markTermFromSelection(projectId, selection(current().body, 'memory'));
      await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
      markTermFromSelection(projectId, selection(current().body, 'storage'));
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      fail(new Error('Offline'));
      await vi.waitFor(() => expect(current().termPreviews?.error).toContain('Redo terms'));
      finish(response('storage'));
      await vi.waitFor(() => expect(termPreviewFor(current(), 'storage')).toBeTruthy());
      expect(current().termPreviews?.exhaustedTerms).toEqual(['memory']);
      expect(current().termPreviews?.error).toContain('Redo terms');
      markTermFromSelection(projectId, selection(current().body, 'Memory'));
      await vi.waitFor(() => expect(termPreviewFor(current(), 'memory')).toBeTruthy());
      expect(current().termPreviews?.error).toBeUndefined();
      expect(current().termPreviews?.exhaustedTerms).toBeUndefined();
      expect(complete).toHaveBeenCalledTimes(3);
      expect(JSON.parse(complete.mock.calls[2]![0].user).terms).toEqual([{ id: 0, term: 'Memory' }]);
    } finally { warn.mockRestore(); }
  });

  it('discards a removed term on undo while another job continues', async () => {
    const finishes: Array<(value: string) => void> = [];
    complete.mockImplementation(() => new Promise<string>(resolve => finishes.push(resolve)));
    const projectId = useGraphStore.getState().project!.id;
    markTermFromSelection(projectId, selection(current().body, 'memory'));
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    markTermFromSelection(projectId, selection(current().body, 'storage'));
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    useGraphStore.temporal.getState().undo();
    expect(complete.mock.calls[0]![0].signal.aborted).toBe(false);
    expect(complete.mock.calls[1]![0].signal.aborted).toBe(true);
    finishes[1]!(response('storage')); finishes[0]!(response('memory'));
    await vi.waitFor(() => expect(termPreviewFor(current(), 'memory')).toBeTruthy());
    expect(termPreviewFor(current(), 'storage')).toBeUndefined();
  });
  it.each(['generating', 'marking', 'stale', 'project'] as const)('rejects %s selections without editing or requesting', reason => {
    const selected = selection(current().body, 'memory');
    const projectId = useGraphStore.getState().project!.id;
    if (reason === 'generating') useGraphStore.getState().updateNode('n', { generating: true });
    if (reason === 'marking') useNodeStatusStore.getState().setStatus('n', 'MARKING CHIPS');
    if (reason === 'stale') selected.sourceBody += ' changed';
    useGraphStore.temporal.getState().clear();
    expect(markTermFromSelection(reason === 'project' ? 'different' : projectId, selected)).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });
});
