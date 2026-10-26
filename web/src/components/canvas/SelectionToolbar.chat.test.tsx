import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SelectionToolbar } from './SelectionToolbar';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { spawnTermClick } from '@/lib/generate';
import { LANGUAGES, type GenerationLanguage } from '@/lib/languages';

vi.mock('@/lib/generate', () => ({ spawnTermClick: vi.fn(), spawnRoutedExplain: vi.fn() }));
vi.mock('@/lib/imageGeneration', () => ({ configuredImageModelAvailable: () => false, spawnImageFromSelection: vi.fn() }));

function fixture(body: string, chunked: boolean, language: GenerationLanguage = 'en') {
  let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 500 });
  for (const [turnId, createdAt] of [['first', 2], ['latest', 3]] as const) {
    node = appendChatAnswer(node, { turnId, createdAt, question: 'Question', metadata: { informationChunking: chunked } });
    node = updateChatAnswer(node, { turnId, versionCreatedAt: createdAt }, { body: turnId === 'first' ? body : 'Latest answer.', language }, { state: 'complete' });
  }
  node = { ...node, generating: false, generatingVersionIndex: undefined };
  const project = createBlankProject('Chat selection', node.id);
  useGraphStore.setState({ project: { ...project, nodes: { chat: node }, selection: [] }, panTo: null });
  const version = node.versions.find(v => v.createdAt === 2)!;
  render(<><div data-node-id="chat"><div data-chat-answer="first" data-chat-answer-created-at={2}>
    <ChatMarkdown nodeId="chat" version={version} />
  </div></div><SelectionToolbar /></>);
  return node.versions.indexOf(version);
}

/** Select actual rendered text, including across bold/link/sentence boundaries. */
function selectRenderedText(selector: string, text: string) {
  const element = document.querySelector<HTMLElement>(selector)!;
  const start = element.textContent!.indexOf(text);
  if (start < 0) throw new Error(`Text not found: ${text}`);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let first = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const end = offset + node.textContent!.length;
    if (!first && start < end) { range.setStart(node, start - offset); first = true; }
    if (first && start + text.length <= end) { range.setEnd(node, start + text.length - offset); break; }
    offset = end;
  }
  act(() => { const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range); });
  fireEvent.mouseUp(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatRuntimeStore.setState({ views: {} });
  useNodeTextSelectionStore.getState().clear();
  useSettingsStore.setState({ selectionWebSearch: { engineId: 'google', customEngines: [] } });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true, value: () => new DOMRect(20, 80, 200, 24),
  });
});
afterEach(() => {
  cleanup(); window.getSelection()?.removeAllRanges();
  useNodeTextSelectionStore.getState().clear(); useGraphStore.getState().setProject(null);
  vi.restoreAllMocks();
});

describe.each([true, false])('chat selection toolbar (chunking=%s)', chunked => {
  it.each([
    ['paragraph', 'A **selected phrase** in an answer.', 'p', 'selected phrase'],
    ['tight bullet', '- A **selected phrase**. Next sentence.\n- Other item.', 'li', 'selected phrase'],
    ['numbered list', '1. A **selected phrase**.\n2. Other item.', 'li', 'selected phrase'],
    ['nested list', '- Parent\n  - A **selected phrase**.', 'li li', 'selected phrase'],
    ['task list', '- [ ] A **selected phrase**.\n- [x] Other item.', 'li', 'selected phrase'],
    ['loose list', '- A **selected phrase**.\n\n- Other item.', 'li', 'selected phrase'],
    ['heading', '## A **selected phrase**', 'h2', 'selected phrase'],
    ['table', '| A | B |\n|---|---|\n| A **selected phrase** | Other |', 'td', 'selected phrase'],
    ['term and citation', '- A [[selected phrase]] ⟦1⟧.', 'li', 'selected phrase'],
    ['second sentence', '- First sentence. A **selected phrase**.', 'li', 'selected phrase'],
    ['mixed script and inline code', '- 日本語 `const x = 1` العربية **selected phrase** हिन्दी.', 'li', 'selected phrase'],
  ])('offers actions on a %s and retains the correct earlier answer', async (_name, body, selector, text) => {
    const versionIndex = fixture(body, chunked);
    selectRenderedText(`.chat-markdown ${selector}`, text);
    const explore = await screen.findByRole('button', { name: 'Explore' });
    const selection = useNodeTextSelectionStore.getState().selection!;
    expect(selection).toMatchObject({ nodeId: 'chat', versionIndex, text, sourceBody: body });
    expect(body.slice(selection.start, selection.end)).toBe(text);
    expect(useGraphStore.getState().project?.nodes.chat?.currentVersionIndex).toBe(versionIndex);
    expect(useGraphStore.getState().panTo).toBeNull();
    expect(screen.getByRole('link', { name: 'Web search' })).toHaveAttribute('href', 'https://www.google.com/search?q=selected%20phrase');
    fireEvent.click(explore);
    expect(spawnTermClick).toHaveBeenCalledWith('chat', text, { sourceSelection: selection });
  });

  it.each(LANGUAGES)('retains exact source text in $name lists', async language => {
    const body = `- **${language.sample}**\n- ${language.sample}`;
    const versionIndex = fixture(body, chunked, language.id);
    selectRenderedText('.chat-markdown li', language.sample);
    await screen.findByRole('button', { name: 'Copy' });
    const selection = useNodeTextSelectionStore.getState().selection!;
    expect(selection).toMatchObject({ text: language.sample, versionIndex });
    expect(body.slice(selection.start, selection.end)).toBe(language.sample);
    expect(document.querySelector('.chat-markdown')).toHaveAttribute('lang', language.locale);
    expect(document.querySelector('.chat-markdown')).toHaveAttribute('dir', language.id === 'ar' ? 'rtl' : 'ltr');
  });
});
