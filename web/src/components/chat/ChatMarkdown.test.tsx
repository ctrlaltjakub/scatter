import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { useChatTableStore } from '@/store/useChatTableStore';
import { ChatMarkdown } from './ChatMarkdown';
import { createChatNode, appendChatAnswer, updateChatAnswer } from '@/lib/chat/model';
import { activateReference } from '@/lib/referenceAction';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { applyTermSelection } from '@/lib/termMarking';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { LANGUAGES } from '@/lib/languages';

vi.mock('@/lib/chat/actions', () => ({ activateChatAnswer: vi.fn() }));
vi.mock('@/lib/referenceAction', () => ({ activateReference: vi.fn() }));
const answer = (body: string, chunked = true) => {
  let node = createChatNode({ id: 'c', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 600 });
  node = appendChatAnswer(node, { turnId: 't', createdAt: 2, question: 'Question', metadata: { informationChunking: chunked } });
  node = updateChatAnswer(node, { turnId: 't', versionCreatedAt: 2 }, { body,
    sources: [{ n: 2, url: 'https://example.com', title: 'Source' }],
    internalSources: [{ n: 1, sourceId: 's', revisionId: 'r', passageId: 'p', sourceTitle: 'Notes', excerpt: 'Fact' }] });
  return node.versions[1]!;
};
describe('chat Markdown presentation', () => {
  it('leaves Google search suggestions to the active answer’s side panel', () => {
    const version = { ...answer('A grounded answer.'), googleSearchSuggestions: ['<div>Google Search</div>'] };
    const { container } = render(<ChatMarkdown nodeId="c" version={version} />);
    expect(container).toHaveTextContent('A grounded answer.');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('.google-search-suggestions')).toBeNull();
  });
  it.each([true, false])('renders highlights, callouts, math, comments and footnotes (chunked=%s)', chunked => {
    const body = '==Important **idea**== %%private note%% with $x^2$. Reference[^1].\n\n> [!note]\n> Useful information.\n\n$$\na^2 + b^2\n$$\n\n[^1]: Extra detail.';
    const { container } = render(<ChatMarkdown nodeId="c" version={answer(body, chunked)} />);
    expect(container.querySelector('mark')).toHaveTextContent('Important idea');
    expect(container.querySelector('[data-markdown-comment]')).not.toBeVisible();
    expect(container.querySelector('blockquote')).toHaveTextContent('Useful information.');
    expect(container.querySelector('blockquote')).not.toHaveTextContent('[!note]');
    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.querySelector('sup a')).toBeInTheDocument();
    expect(container).toHaveTextContent('Extra detail.');
  });
  it('toggles a task from an unfocused node without focusing it, and supports undo', () => {
    const version = answer('- [ ] First\n  - [x] Nested', false);
    const project = createBlankProject('Tasks', 'c');
    project.nodes.c = { id: 'c', type: 'manual-empty', frozen: false, position: { x: 0, y: 0 }, currentVersionIndex: 0, versions: [version] };
    project.selection = [];
    useGraphStore.setState({ project, activeProjectId: project.id });
    useGraphStore.temporal.getState().clear();
    render(<ChatMarkdown nodeId="c" version={version} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(useGraphStore.getState().project!.nodes.c!.versions[0]!.body).toBe('- [x] First\n  - [x] Nested');
    expect(useGraphStore.getState().project!.selection).toEqual([]);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.nodes.c!.versions[0]!.body).toBe(version.body);
  });
  it.each([true, false])('keeps escaped and entity-encoded break examples literal (chunked=%s)', (chunked) => {
    const { container } = render(<ChatMarkdown nodeId="c" version={answer('| Example |\n|---|\n| \\<br\\> and &lt;br&gt; and \\< br > |\n| &amp; one< br >two |', chunked)} />);
    expect(container.querySelectorAll('td br')).toHaveLength(1);
    expect(container.querySelector('td')).toHaveTextContent('<br> and <br> and < br >');
  });
  it.each([true, false])('renders table breaks and rich content safely (chunked=%s)', (chunked) => {
    const { container } = render(<ChatMarkdown nodeId="c" version={answer('| A | B |\n|:---|---:|\n| **Bold**<br>*Italic*< br >~~Old~~<br/>[[cache]] | `literal <br>` &amp; [link](https://example.com) |\n| ![diagram](https://example.com/image.png) | <script>alert(1)</script> |', chunked)} />);
    expect(container.querySelectorAll('td br')).toHaveLength(3);
    expect(container.querySelector('td strong')).toHaveTextContent('Bold');
    expect(container.querySelector('td em')).toHaveTextContent('Italic');
    expect(container.querySelector('td del')).toHaveTextContent('Old');
    expect(screen.getByRole('button', { name: 'cache' })).toBeInTheDocument();
    expect(container.querySelector('code')).toHaveTextContent('literal <br>');
    expect(screen.getByRole('img', { name: 'diagram' })).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy table' })).toBeVisible();
    expect([...container.querySelectorAll('.chat-table-actions button')].map(button => button.textContent?.trim()))
      .toEqual(['View table fullscreen', 'Copy to node', 'Copy table']);
  });
  it('renders first-pass selections in headings, bold bullet titles and table cells', () => {
    const body = '# Therapy\n\n- **Programming**\n  - A programmer writes code.\n\n| Method |\n|---|\n| **Cognitive** behavioral therapy |';
    const marked = applyTermSelection(body, '{"terms":["Therapy","Programming","programmer","code","Cognitive behavioral therapy"]}')!;
    const { container } = render(<ChatMarkdown nodeId="c" version={answer(marked)} />);
    expect(screen.getByRole('heading', { name: 'Therapy' }).querySelector('.ref-chip')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Programming' }).closest('strong')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'programmer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'code' })).toBeInTheDocument();
    const term = screen.getByRole('button', { name: 'Cognitive behavioral therapy' });
    expect(term.closest('td')).not.toBeNull();
    expect(term.querySelector('strong')).toHaveTextContent('Cognitive');
    expect(container.textContent).not.toMatch(/\[\[|\]\]|\*/);
  });
  it.each([true, false])('preserves explicit poem line breaks (chunked=%s)', (chunked) => {
    const poem = 'In the Caverns of the Deep,\\\nWhere the ancient Titans sleep,\\\nSpoke the Healer of the Soul\\\nTo the Furnace of the Whole.\n\n*Jung:*\\\n“Mighty Sovereign, fierce and blind,  \nDwelling boundless in the Mind.”';
    const { container } = render(<ChatMarkdown nodeId="c" version={answer(poem, chunked)} />);
    expect(container.querySelectorAll('br')).toHaveLength(5);
    expect(container.querySelector('em')).toHaveTextContent('Jung:');
    expect(container.innerHTML).toMatch(/sleep,<br\s*\/?>\s*Spoke/);
    expect(container.innerHTML).toMatch(/<em>Jung:<\/em><br\s*\/?>/);
  });
  it('keeps authored soft wraps for normal CSS whitespace handling', () => {
    const { container } = render(<ChatMarkdown nodeId="c" version={answer('First line,\nsecond line.', false)} />);
    expect(container.textContent).toBe('First line,\nsecond line.');
    expect(container).toHaveTextContent('First line, second line.');
  });
  it('leaves two sentences on one authored line, including old content, together', () => {
    const { container } = render(<ChatMarkdown nodeId="c" version={answer('One sentence. Another sentence.')} />);
    expect(container.querySelectorAll('.sc-ab-sentence')).toHaveLength(1);
    expect(container.querySelector('.sc-ab-sentence')).toHaveTextContent('One sentence. Another sentence.');
  });
  it.each(LANGUAGES)('toggles authored line presentation without changing text or paragraphs in $name', language => {
    const body = `**${language.sample}**\n${language.sample}\n\n${language.sample}`;
    const { container, rerender } = render(<ChatMarkdown nodeId="c" version={{ ...answer(body), language: language.id }} />);
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect([...container.querySelectorAll('.sc-ab-sentence')].map(element => element.textContent?.trim()))
      .toEqual([language.sample, language.sample, language.sample]);
    expect(container.querySelectorAll('strong')).toHaveLength(1);
    rerender(<ChatMarkdown nodeId="c" version={{ ...answer(body, false), language: language.id }} />);
    expect(container.querySelector('.sc-ab-sentence')).toBeNull();
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.querySelector('p')?.textContent).toBe(`${language.sample}\n${language.sample}`);
  });
  it.each([true, false])('keeps source-selection anchors aligned across authored lines (chunked=%s)', chunked => {
    const body = 'First **line**.\nA **second word** follows.\nLast line.';
    const version = answer(body, chunked);
    const project = createBlankProject('Authored lines', 'c');
    project.nodes.c = { id: 'c', type: 'manual-empty', frozen: false, position: { x: 0, y: 0 }, currentVersionIndex: 0, versions: [version] };
    project.arrows = { relation: { id: 'relation', kind: 'auto', fromNodeId: 'c', toNodeId: 'child',
      sourceAnswer: { turnId: 't', versionCreatedAt: 2 },
      sourceSelection: { sourceVersionCreatedAt: 2, createdAt: 3, text: 'second word',
        parts: [{ sourceField: 'chat:0', start: body.indexOf('second word'), end: body.indexOf('second word') + 11, text: 'second word' }] } } };
    useGraphStore.setState({ project, activeProjectId: project.id });
    const { container } = render(<ChatMarkdown nodeId="c" version={version} />);
    expect(container.querySelector('.source-selection-mark')).toHaveTextContent('second word');
    expect(container.querySelector('.source-selection-mark')?.closest('strong')).not.toBeNull();
  });
  it('keeps detached citations visible without creating a hanging sentence or fact-check target', () => {
    const { container } = render(<ChatMarkdown nodeId="c" version={answer('A fact.\n⟦2⟧\nAnother fact.\n\n⟦2⟧')} />);
    expect(container.querySelectorAll('.sc-ab-sentence')).toHaveLength(2);
    expect(container.querySelectorAll('[data-chat-unit]')).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Source 2' })).toHaveLength(2);
  });
  it.each([true, false])('renders a whole term containing italic text, preserving emphasis (chunked=%s)', (chunked) => {
    vi.mocked(activateReference).mockClear();
    useLiveViewportStore.setState({ zoom: 1 });
    const { container } = render(<ChatMarkdown nodeId="c" version={answer(
      'Jung distinguished **metaphysical claims** from the **[[God-image (*imago Dei*)]]**, a psychological reality. ⟦2⟧', chunked,
    )} />);
    const term = screen.getByRole('button', { name: 'God-image (imago Dei)' });
    expect(term).toHaveAttribute('data-reference-term', 'God-image (imago Dei)');
    expect(term.closest('strong')).not.toBeNull();
    expect(term.querySelector('em')).toHaveTextContent('imago Dei');
    expect(container.textContent).not.toMatch(/\[\[|\]\]|\*/);
    expect(screen.getByRole('link', { name: 'Source 2' })).toBeInTheDocument();
    fireEvent.click(term);
    expect(activateReference).toHaveBeenCalledTimes(1);
    expect(activateReference).toHaveBeenCalledWith('c', 'God-image (imago Dei)', {
      withModifier: false, sourceAnswer: { turnId: 't', versionCreatedAt: 2 },
    });
  });
  it.each([
    '**[[God-image (*****imago Dei*****)]]**',
    '[[**God-image** (*imago Dei*)]]',
    '[[God-**image** (*imago Dei*)]]',
  ])('handles term markers spanning nested emphasis: %s', (markdown) => {
    const { container } = render(<ChatMarkdown nodeId="c" version={answer(`The ${markdown} matters.`)} />);
    const term = screen.getByRole('button', { name: 'God-image (imago Dei)' });
    expect(term.querySelector('em')).toHaveTextContent('imago Dei');
    expect(container.querySelectorAll('.ref-chip')).toHaveLength(1);
    expect(container.textContent).toBe('The God-image (imago Dei) matters.');
  });
  it('keeps term-like code and link text literal, without nested clickable elements', () => {
    const { container } = render(<ChatMarkdown nodeId="c" version={answer(
      '`[[God-image (*imago Dei*)]]` and [a [[marked *label*]]](https://example.com).',
    )} />);
    expect(container.querySelector('.ref-chip')).toBeNull();
    expect(container.querySelector('code')).toHaveTextContent('[[God-image (*imago Dei*)]]');
    expect(screen.getByRole('link')).toHaveTextContent('a [[marked label]]');
  });
  it('renders real headings, noncollapsible lists, terms, and both citation kinds', () => {
    const { container } = render(<ChatMarkdown nodeId="c" version={answer('# Heading\n\nA **[[learning term]]** matters. (1)\nAnother fact follows. ⟦2⟧\n\n- A complete list item.')} />);
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'learning term' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Project source 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Source 2' })).toBeInTheDocument();
    expect(container.querySelector('ul li')).toHaveTextContent('A complete list item.');
    expect(container.querySelectorAll('.sc-ab-sentence').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector('.sc-collapsible-toggle')).toBeNull();
  });
  it('keeps ordinary Markdown paragraphs in normal mode and gives each table an enlarge control', () => {
    const { container } = render(<ChatMarkdown nodeId="c" version={answer('First idea. Second idea.\n\n| Name | Value |\n|---|---|\n| Go | 19 |', false)} />);
    expect(container.querySelector('.sc-ab-sentence')).toBeNull();
    expect(screen.getByRole('table')).toHaveTextContent('NameValueGo19');
    expect(screen.getByRole('button', { name: 'View table fullscreen' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Scrollable table' })).toBeInTheDocument();
  });
  it('keeps sentence-ending terms and their punctuation together when chunked', () => {
    const { container } = render(<ChatMarkdown nodeId="c" version={answer(
      'This ends with a [[term]].\nAnother ends with **[[bold terms]]**.\nA third ends with **bold words**.',
    )} />);
    const sentences = Array.from(container.querySelectorAll('.sc-ab-sentence'));
    expect(sentences.map(sentence => sentence.textContent?.trim())).toEqual([
      'This ends with a term.', 'Another ends with bold terms.', 'A third ends with bold words.',
    ]);
    expect(sentences[0]?.querySelector('.ref-chip')).toHaveTextContent('term');
    expect(sentences[1]?.querySelector('strong .ref-chip')).toHaveTextContent('bold terms');
  });
  it('keeps table identities stable through strict-mode renders and fullscreen filtering', () => {
    const version = answer('| One |\n|---|\n| First |\n\n| Two |\n|---|\n| Second |');
    const { rerender } = render(<StrictMode><ChatMarkdown nodeId="c" version={version} /></StrictMode>);
    fireEvent.click(screen.getAllByRole('button', { name: 'View table fullscreen' })[1]!);
    expect(useChatTableStore.getState().target?.tableIndex).toBe(1);
    rerender(<StrictMode><ChatMarkdown nodeId="c" version={version} tableOnly={1} /></StrictMode>);
    expect(screen.getByRole('table')).toHaveTextContent('TwoSecond');
    expect(screen.queryByText('First')).toBeNull();
  });
});
