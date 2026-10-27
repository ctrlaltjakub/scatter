import { describe, expect, it } from 'vitest';
import {
  answerVersion, appendChatAnswer, captureChatParent, chatInitialBodyHeight,
  chatParentPending, conversationPath, createChatNode, forkChatConversation,
  recoverChatNode, removeChatAnswer, removeLastChatTurn, selectLatestChatAlternative, updateChatAnswer,
} from './model';

const initial = () => createChatNode({ id: 'chat', createdAt: 1,
  position: { x: 300, y: 200 }, bodyHeight: 620, parentNodeId: 'parent' });
const first = () => appendChatAnswer(initial(), { turnId: 'a', createdAt: 2, question: 'What is Go?' });

describe('chat conversation ownership', () => {
  it('keeps fixed geometry and a placeholder before any exchange exists', () => {
    const node = initial();
    expect(node.chat?.turns).toEqual([]);
    expect(node.versions[0]!).toMatchObject({ width: 672, bodyMaxHeight: 620, header: 'Chat' });
    expect(chatInitialBodyHeight(1000, 0.1)).toBe(chatInitialBodyHeight(1000, 0.35));
  });

  it('starts 10% wider and 20% taller without resizing saved chats', () => {
    expect(initial().versions[0]!.width).toBe(Math.round(611 * 1.1));
    for (const screenHeight of [600, 800, 1000, 1440]) {
      const oldHeight = Math.floor(((screenHeight - 40) / .75 - 210) / 2);
      expect(Math.abs(chatInitialBodyHeight(screenHeight) - oldHeight * 1.2)).toBeLessThanOrEqual(2);
    }
  });

  it('preserves the paired question and mode on each alternative', () => {
    let node = first();
    node = appendChatAnswer(node, { turnId: 'a', createdAt: 3, question: 'What is Japanese Go?',
      replaceLatest: true, metadata: { informationChunking: false } });
    expect(node.chat?.turns).toHaveLength(1);
    expect(node.versions[1]!.chat).toMatchObject({ question: 'What is Go?', informationChunking: true });
    expect(node.versions[2]!.chat).toMatchObject({ question: 'What is Japanese Go?', informationChunking: false });
    node = selectLatestChatAlternative(node, { turnId: 'a', versionCreatedAt: 2 });
    node = appendChatAnswer(node, { turnId: 'b', createdAt: 4, question: 'And its history?' });
    expect(node.versions.at(-1)?.chat?.contextPath).toEqual([{ turnId: 'a', versionCreatedAt: 2 }]);
    expect(selectLatestChatAlternative(node, { turnId: 'a', versionCreatedAt: 3 })).toBe(node);
    expect(conversationPath(node)[0]!.versionCreatedAt).toBe(2);
  });

  it('rejects historical regeneration and duplicate version identities', () => {
    const node = appendChatAnswer(first(), { turnId: 'b', createdAt: 3, question: 'History?' });
    expect(() => appendChatAnswer(node, { turnId: 'a', createdAt: 4, question: 'x', replaceLatest: true })).toThrow();
    expect(() => appendChatAnswer(node, { turnId: 'c', createdAt: 3, question: 'x' })).toThrow();
  });

  it('targets late results by exact answer, never whichever answer is displayed', () => {
    const one = first();
    const two = appendChatAnswer(one, { turnId: 'a', createdAt: 3, question: 'Again?', replaceLatest: true });
    const updated = updateChatAnswer(two, { turnId: 'a', versionCreatedAt: 2 }, { body: 'Old answer' });
    expect(updated.versions[1]!.body).toBe('Old answer');
    expect(updated.versions[2]!.body).toBe('');
    expect(two.versions[1]!.body).toBe('');
    expect(updateChatAnswer(two, { turnId: 'missing', versionCreatedAt: 3 }, { body: 'wrong' })).toBe(two);
  });

  it('waits for the displayed parent, but not background generation of another version', () => {
    const parent = first();
    expect(chatParentPending(parent)).toBe(true);
    expect(() => captureChatParent(parent, 'p')).toThrow(/finish/);
    parent.currentVersionIndex = 0;
    expect(chatParentPending(parent)).toBe(false);
    expect(captureChatParent(parent, 'p').versionCreatedAt).toBe(1);
  });

  it('reuses unchanged parent snapshots and freezes image/version ownership', () => {
    const parent = initial();
    parent.versions[0]!.media = { source: 'asset', kind: 'image', assetId: 'original' };
    const snapshot = captureChatParent(parent, 'p1');
    let node = appendChatAnswer(initial(), { turnId: 'a', createdAt: 2, question: 'Describe', parentSnapshot: snapshot });
    parent.versions[0]!.media.assetId = 'edited';
    expect(node.chat?.parentSnapshots.p1!.media?.assetId).toBe('original');
    node = appendChatAnswer(node, { turnId: 'b', createdAt: 3, question: 'More', parentSnapshot: { ...snapshot, id: 'p2' } });
    expect(node.chat?.parentSnapshots.p1!.media?.assetId).toBe('original');
    expect(Object.keys(node.chat!.parentSnapshots)).toEqual(['p1']);
    expect(node.versions.at(-1)?.chat?.parentSnapshotId).toBe('p1');
  });

  it('forks only the chosen prefix, retains metadata, and never mutates the source', () => {
    let node = first();
    node = updateChatAnswer(node, { turnId: 'a', versionCreatedAt: 2 }, {
      body: '**Answer** [[Go]]', sources: [{ n: 1, url: 'https://example.com' }],
    }, { state: 'complete', titleManual: true });
    node = appendChatAnswer(node, { turnId: 'a', createdAt: 3, question: 'Alternative', replaceLatest: true });
    node = appendChatAnswer(node, { turnId: 'b', createdAt: 4, question: 'Later' });
    const before = structuredClone(node);
    const { node: fork } = forkChatConversation(node, { turnId: 'a', versionCreatedAt: 2 }, 'fork', () => 'copy-a');
    expect(node).toEqual(before);
    expect(fork.chat?.turns).toHaveLength(1);
    expect(fork.chat?.turns[0]!.versionCreatedAts).toEqual([2, 3]);
    expect(fork.versions.some((version) => version.createdAt === 4)).toBe(false);
    const answer = answerVersion(fork, { turnId: 'copy-a', versionCreatedAt: 2 });
    expect(answer?.sources).toEqual(before.versions[1]!.sources);
    expect(answer?.chat?.titleManual).toBe(true);
    answer!.sources![0]!.url = 'https://changed.example';
    expect(node.versions[1]!.sources![0]!.url).toBe('https://example.com');
    expect(fork.chat?.parentNodeId).toBe('parent');
    expect(fork.chat?.forkedFrom?.nodeId).toBe('chat');
    expect(fork.chat?.title).toBe('What is Go? — forked at “What is Go?”');
    expect(fork.chat?.titleManual).toBe(true);
  });

  it('identifies the chosen answer alternative and shortens only the fork header', () => {
    const question = 'A very long question about the history of Go and its different rules across countries.\n' + 'More detail. '.repeat(30);
    const source = appendChatAnswer(first(), { turnId: 'a', createdAt: 3, question, replaceLatest: true });
    const { node: fork } = forkChatConversation(source, { turnId: 'a', versionCreatedAt: 3 }, 'fork', () => 'copy-a');
    expect(fork.chat?.title).toMatch(/^What is Go\? — forked at “A very long question/);
    expect(fork.chat?.title).toMatch(/…”$/);
    expect(fork.chat?.title).not.toContain('\n');
    expect(fork.chat!.title.length).toBeLessThan(110);
    expect(answerVersion(fork, { turnId: 'copy-a', versionCreatedAt: 3 })?.chat?.question).toBe(question);
    const continued = appendChatAnswer(fork, { turnId: 'b', createdAt: 4, question: 'Continue' });
    expect(continued.chat?.title).toBe(fork.chat?.title);
  });

  it('invalidates compaction covering an alternative excluded from a fork', () => {
    let node = appendChatAnswer(first(), { turnId: 'a', createdAt: 3, question: 'Alternate', replaceLatest: true });
    node.chat!.memory = { id: 'm', createdAt: 4, summary: 'Alternate facts', coveredPath: conversationPath(node) };
    node.chat!.compactions = [{ memory: node.chat!.memory }];
    const { node: fork } = forkChatConversation(node, { turnId: 'a', versionCreatedAt: 2 }, 'fork', () => 'copy-a');
    expect(fork.chat?.memory).toBeUndefined();
    expect(fork.chat?.compactions).toEqual([]);
  });

  it('deletes the last whole turn and memory without discarding earlier versions', () => {
    let node = appendChatAnswer(first(), { turnId: 'b', createdAt: 3, question: 'Later' });
    expect(() => removeLastChatTurn(node)).toThrow(/Stop/);
    node = { ...node, generating: false };
    node.chat!.memory = { id: 'm', summary: 'Both', createdAt: 4, coveredPath: conversationPath(node) };
    const deleted = removeLastChatTurn(node);
    expect(deleted.chat?.turns.map((turn) => turn.id)).toEqual(['a']);
    expect(deleted.versions).toHaveLength(2);
    expect(deleted.chat?.memory).toBeUndefined();
    expect(node.chat?.turns).toHaveLength(2);
  });

  it.each([[2, 3], [3, 2], [4, 3]])('deletes answer %s and selects its nearest preceding survivor (%s)', (deletedAt, selectedAt) => {
    let node = first();
    for (const createdAt of [3, 4]) node = appendChatAnswer(node, {
      turnId: 'a', createdAt, question: `Question ${createdAt}`, replaceLatest: true,
    });
    node = { ...selectLatestChatAlternative(node, { turnId: 'a', versionCreatedAt: deletedAt }),
      generating: false, currentVersionIndex: deletedAt - 1 };
    const original = structuredClone(node);
    const next = removeChatAnswer(node, { turnId: 'a', versionCreatedAt: deletedAt });
    expect(next.chat?.turns).toEqual([{ id: 'a', versionCreatedAts: [2, 3, 4].filter(at => at !== deletedAt),
      selectedVersionCreatedAt: selectedAt }]);
    expect(next.versions[next.currentVersionIndex]?.createdAt).toBe(selectedAt);
    expect(next.versions).toEqual(original.versions.filter(version => version.createdAt !== deletedAt));
    expect(node).toEqual(original);
  });

  it('keeps other turns, metadata and compaction that does not cover the deleted alternative', () => {
    let node = updateChatAnswer(first(), { turnId: 'a', versionCreatedAt: 2 }, {
      language: 'ar', body: '**المعرفة** — 日本語 — हिन्दी — café `value.x`',
      sources: [{ n: 1, url: 'https://example.com' }],
    }, { state: 'complete' });
    node = appendChatAnswer(node, { turnId: 'b', createdAt: 3, question: 'Follow-up' });
    node = appendChatAnswer(node, { turnId: 'b', createdAt: 4, question: 'Edited follow-up', replaceLatest: true });
    node = { ...node, generating: false, currentVersionIndex: 1 };
    const memory = { id: 'm', createdAt: 5, summary: 'First answer', coveredPath: conversationPath(node).slice(0, 1) };
    node.chat!.memory = memory;
    node.chat!.compactions = [{ memory }];
    const next = removeChatAnswer(node, { turnId: 'b', versionCreatedAt: 3 });
    expect(next.versions[next.currentVersionIndex]).toBe(node.versions[1]);
    expect(next.chat?.turns[0]).toBe(node.chat?.turns[0]);
    expect(next.chat?.turns[1]?.selectedVersionCreatedAt).toBe(4);
    expect(next.chat?.memory).toBe(memory);
    expect(next.chat?.compactions).toEqual([{ memory }]);
    expect(next.versions.at(-1)?.chat?.contextPath).toEqual([{ turnId: 'a', versionCreatedAt: 2 }]);
  });

  it('drops compaction that includes a deleted answer, without touching remaining answer data', () => {
    let node = appendChatAnswer(first(), { turnId: 'a', createdAt: 3, question: 'Again', replaceLatest: true });
    const memory = { id: 'm', createdAt: 4, summary: 'Removed answer', coveredPath: conversationPath(node) };
    node = { ...node, generating: false, chat: { ...node.chat!, memory, compactions: [{ memory }] } };
    const next = removeChatAnswer(node, { turnId: 'a', versionCreatedAt: 3 });
    expect(next.chat?.memory).toBeUndefined();
    expect(next.chat?.compactions).toEqual([]);
    expect(next.versions[1]).toBe(node.versions[1]);
  });

  it('rejects missing, historical and final-answer deletion; never silently deletes the turn', () => {
    let node = appendChatAnswer(first(), { turnId: 'a', createdAt: 3, question: 'Again', replaceLatest: true });
    expect(() => removeChatAnswer(node, { turnId: 'a', versionCreatedAt: 3 })).toThrow(/Stop/);
    node = { ...appendChatAnswer(node, { turnId: 'b', createdAt: 4, question: 'Next' }), generating: false };
    for (const ref of [{ turnId: 'b', versionCreatedAt: 4 }, { turnId: 'a', versionCreatedAt: 2 },
      { turnId: 'b', versionCreatedAt: 999 }, { turnId: 'missing', versionCreatedAt: 4 }]) {
      expect(removeChatAnswer(node, ref)).toBe(node);
    }
  });

  it('recovers interruptions on a copy and never replays jobs', () => {
    const node = first();
    node.versions[1]!.body = 'Partial answer';
    node.versions[1]!.chat!.tools = [{ id: 't', name: 'search_conversation', summary: 'Searching', state: 'running' }];
    const recovered = recoverChatNode(node);
    expect(recovered.versions[1]!.body).toBe('Partial answer');
    expect(recovered.versions[1]!.chat?.state).toBe('interrupted');
    expect(recovered.versions[1]!.chat?.tools?.[0]?.state).toBe('stopped');
    expect(node.versions[1]!.chat?.state).toBe('generating');
  });
  it('remaps the compaction event boundary when forking or deleting the last turn', () => {
    const node = { ...appendChatAnswer(first(), { turnId: 'b', createdAt: 3, question: 'Later' }), generating: false };
    const memory = { id: 'm', summary: 'First answer', createdAt: 4, coveredPath: conversationPath(node).slice(0, 1) };
    node.chat!.memory = memory;
    node.chat!.compactions = [{ memory, afterTurnId: 'b' }];
    let id = 0;
    const { node: fork } = forkChatConversation(node, { turnId: 'b', versionCreatedAt: 3 }, 'fork', () => `copy-${++id}`);
    expect(fork.chat?.compactions[0]?.afterTurnId).toBe('copy-2');
    expect(removeLastChatTurn(node).chat?.compactions[0]?.afterTurnId).toBe('a');
    expect(node.chat?.compactions[0]?.afterTurnId).toBe('b');
  });
});
