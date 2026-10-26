import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdaptiveBullets, renderBulletInner } from './AdaptiveBullets';
import { maxMode } from '@/lib/bulletLayout';
import { parseBody } from '@/lib/bulletParse';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { Arrow, ScatterNode } from '@/store/types';
import { useRewriteStore } from '@/store/useRewriteStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { applyTermSelection } from '@/lib/termMarking';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // jsdom returns 0×0 for every element; cascade + measure-correct loop
  // both need realistic heights. Per-class sizing:
  //   .sc-ab-root: container, 280px tall (the body's available area)
  //   .sc-ab-freetext: 40px paragraph
  //   .sc-ab-item: depends on how many described/inline children rendered
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    const cls = el.classList;
    let h = 0;
    const w = 480;
    if (cls?.contains('sc-ab-root')) {
      h = 280;
    } else if (cls?.contains('sc-ab-freetext')) {
      h = 40;
    } else if (cls?.contains('sc-ab-item')) {
      const titleH = 28;
      const describedRows = el.querySelectorAll('.sc-ab-described').length;
      const hasInline = el.querySelector('.sc-ab-inline') !== null;
      h = titleH + describedRows * 22 + (hasInline ? 22 : 0);
    } else {
      h = 0;
    }
    return {
      x: 0, y: 0, top: 0, left: 0, right: w, bottom: h,
      width: w, height: h, toJSON: () => ({}),
    } as DOMRect;
  };
});

const REALISTIC = `**Lactic fermentation** converts [[glucose]] to [[lactic acid]] anaerobically.

- **Process**
  - **Substrate**: [[glucose]] from carbohydrates
  - **Enzyme**: [[lactate dehydrogenase]] catalyzes the reaction
  - **Products**: [[lactic acid]] and regenerated NAD+
  - **Yield**: about 2 [[ATP]] per molecule
- **Conditions**
  - **Anaerobic**: occurs when [[oxygen]] is limited
  - **Substrate**: [[glycolysis]] intermediates required
  - **Cells**: [[fast-twitch fibers]] during sprints
  - **pH**: optimal around 6 to 7
- **Applications**
  - **Food**: [[yogurt]], [[sauerkraut]], [[kimchi]]
  - **Industry**: [[bioplastics]] and [[lactic acid polymers]]
  - **Medicine**: [[wound healing]] research
  - **Agriculture**: [[silage]] preservation`;

function seedSourceRelations(body: string, arrows: Arrow[], selection: string[] = []): void {
  const makeNode = (id: string): ScatterNode => ({
    id,
    type: id === 'p1' ? 'root' : 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{ header: id, body, createdAt: 100, generatedBy: 'root' }],
    currentVersionIndex: 0,
  });
  const project = createBlankProject('source relations', 'p1');
  const childIds = new Set(arrows.map((arrow) => arrow.toNodeId));
  useGraphStore.setState({
    project: {
      ...project,
      nodes: {
        p1: makeNode('p1'),
        ...Object.fromEntries([...childIds].map((id) => [id, makeNode(id)])),
      },
      arrows: Object.fromEntries(arrows.map((arrow) => [arrow.id, arrow])),
      selection,
    },
    highlight: null,
  });
}

function selectedArrow(
  id: string,
  body: string,
  text: string,
  start: number,
  end: number,
  createdAt: number,
): Arrow {
  return {
    id,
    kind: 'auto',
    fromNodeId: 'p1',
    toNodeId: `${id}-child`,
    sourceSelection: {
      sourceVersionCreatedAt: 100,
      createdAt,
      text,
      parts: [{ sourceField: 'ft', start, end, text }],
    },
  };
}

describe('AdaptiveBullets', () => {
  // Default to the per-sentence rendering (the shipped default) before each
  // test; the "off" test flips it and this resets it.
  beforeEach(() => {
    useSettingsStore.setState({ sentencePerLine: true, justifyParagraph: false });
    // Reset transient per-node active-bullet state so tests don't leak into
    // each other (an expanded bullet now stays expanded — it no longer
    // self-collapses on re-click).
    useActiveIdxStore.setState({ byNodeId: {} });
    useGraphStore.setState({ project: null, highlight: null });
    useRewriteStore.setState({ activeByNode: {}, workingBody: {}, snapshot: {} });
    useCitationPanelStore.getState().close();
  });

  it('renders the free-text paragraph and bullet rows', () => {
    const { container } = render(
      <AdaptiveBullets body={REALISTIC} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    expect(container.querySelector('[data-sc-adaptive="true"]')).not.toBeNull();
    expect(container.querySelector('.sc-ab-freetext')).not.toBeNull();
    // Visible list items only — exclude the hidden measurement clones.
    expect(
      container.querySelectorAll('.sc-ab-list:not(.sc-ab-measure *) > .sc-ab-item').length,
    ).toBe(3);
    expect(screen.getAllByText('Process').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Conditions').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Applications').length).toBeGreaterThan(0);
  });

  it('adds progressive fact colors without taking click priority from terms', () => {
    seedSourceRelations(REALISTIC, [], ['p1']);
    const node = useGraphStore.getState().project!.nodes.p1!;
    const current = node.versions[0]!;
    current.factCheck = {
      pending: {
        schemaVersion: 1,
        bodyFingerprint: 'hash',
        versionCreatedAt: current.createdAt,
        providerId: 'p1',
        model: 'm',
        startedAt: 1,
        complete: false,
        failedUnitIds: [],
        units: [{
          id: 'opening:0', order: 0, stage: 'opening', kind: 'sentence',
          text: 'Lactic fermentation converts glucose to lactic acid anaerobically.',
          sentenceIndex: 0, state: 'complete',
          finding: {
            verdict: 'supported',
            explanation: 'Supported.',
            evidence: [],
          },
        }, {
          id: 'bullet:0:0', order: 1, stage: 'bullets', kind: 'sub-bullet',
          text: 'Substrate: glucose from carbohydrates.',
          sectionTitle: 'Process', bulletIndex: 0, childIndex: 0,
          state: 'complete',
          finding: {
            verdict: 'contradicted',
            explanation: 'Contradicted.',
            evidence: [],
          },
        }],
      },
    };
    useCitationPanelStore.getState().openFact('p1', current.createdAt, 'opening:0');
    const onReferenceClick = vi.fn();
    const { container } = render(
      <AdaptiveBullets body={REALISTIC} parentNodeId="p1" onReferenceClick={onReferenceClick} />,
    );
    expect(container.querySelector('[data-fact-unit="opening:0"]')).toHaveClass(
      'fact-check-unit', 'fact-supported', 'fact-active',
    );
    expect(container.querySelector('[data-fact-unit="bullet:0:0"]')).toHaveClass(
      'fact-check-unit', 'fact-contradicted',
    );
    for (const unit of container.querySelectorAll('[data-fact-unit]')) {
      expect(unit).toHaveAttribute('data-tip', 'Review evidence');
    }

    const glucose = [...container.querySelectorAll<HTMLElement>('.ref-chip')]
      .find((chip) => chip.textContent === 'glucose')!;
    fireEvent.click(glucose);
    expect(onReferenceClick).toHaveBeenCalledWith('glucose', { withModifier: false });
    expect(useCitationPanelStore.getState().activeFactUnitId).toBe('opening:0');

    fireEvent.click(container.querySelector('[data-fact-unit="bullet:0:0"]')!);
    expect(useCitationPanelStore.getState().activeFactUnitId).toBe('bullet:0:0');
  });

  it('annotates visible prose and bullet fields for exact source selection', () => {
    const { container } = render(
      <AdaptiveBullets body={REALISTIC} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    expect(container.querySelector('.sc-ab-root > [data-sc-source-field="ft"]')).not.toBeNull();
    expect(container.querySelector('.sc-ab-root > .sc-ab-list [data-sc-source-field="b:0:title"]')).not.toBeNull();
    expect(container.querySelector('.sc-ab-root > .sc-ab-list [data-sc-source-field="b:0:c:0:name"]')).not.toBeNull();
  });

  it('collapsed mode shows only the opening paragraph in the VISIBLE body', () => {
    // A collapsed node still measures its bullets invisibly at mount so the
    // first expand is free (see AdaptiveBullets.labLifecycle). The off-screen
    // `.sc-ab-measure` labs therefore CAN be present and their copies contain
    // every bullet — the contract here is the VISIBLE rendering only.
    const onFreeTextH = vi.fn();
    const { container } = render(
      <AdaptiveBullets
        body={REALISTIC}
        parentNodeId="p1"
        onReferenceClick={() => {}}
        onFreeTextH={onFreeTextH}
        collapsed
      />,
    );

    expect(container.querySelector('[data-sc-adaptive="true"]')).not.toBeNull();
    expect(container.querySelector('[data-sc-collapsed="true"]')).not.toBeNull();
    expect(container.querySelector('.sc-ab-root > .sc-ab-freetext')).not.toBeNull();
    expect(container.querySelector('.sc-ab-root > .sc-ab-list')).toBeNull();
    expect(container.querySelector('.sc-ab-divider')).toBeNull();
    // Visible free-text shows the intro; the bullet title 'Process' lives
    // only inside the off-screen measurement labs, never in the visible list.
    expect(container.querySelector('.sc-ab-root > .sc-ab-freetext')!.textContent).toContain('Lactic fermentation');
    expect(onFreeTextH).toHaveBeenCalled();
    expect(onFreeTextH.mock.calls.at(-1)?.[0]).toBe(40);
  });

  it('collapsed parked-list mode keeps the visible list mounted but hidden', () => {
    const { container } = render(
      <AdaptiveBullets
        body={REALISTIC}
        parentNodeId="p1"
        onReferenceClick={() => {}}
        collapsed
        parkCollapsedList
      />,
    );

    const parkedList = container.querySelector<HTMLElement>('.sc-ab-root > .sc-ab-list');
    expect(parkedList).not.toBeNull();
    expect(parkedList!.style.display).not.toBe('none');
    expect(parkedList!.style.visibility).toBe('hidden');
    expect(parkedList!.style.pointerEvents).toBe('none');
    expect(parkedList!.getAttribute('aria-hidden')).toBe('true');
  });

  it('deferred measurement mode keeps visible bullets but skips hidden labs', () => {
    const { container } = render(
      <AdaptiveBullets
        body={REALISTIC}
        parentNodeId="p1"
        onReferenceClick={() => {}}
        deferHiddenLabs
      />,
    );

    expect(container.querySelector('.sc-ab-root > .sc-ab-list')).not.toBeNull();
    expect(container.querySelector('.sc-ab-measure')).toBeNull();
  });

  it('renders prose-only body without crashing', () => {
    const { container } = render(
      <AdaptiveBullets
        body="Just prose, no bullets at all."
        parentNodeId="p1"
        onReferenceClick={() => {}}
      />,
    );
    expect(container.querySelector('[data-sc-adaptive="true"]')).not.toBeNull();
    expect(container.querySelector('.sc-ab-list')).toBeNull();
    expect(screen.getByText(/Just prose/)).toBeInTheDocument();
  });

  it('renders [[refs]] as ReferenceChip in title, name, description, and free text', () => {
    const fn = vi.fn();
    const { container } = render(
      <AdaptiveBullets body={REALISTIC} parentNodeId="p1" onReferenceClick={fn} />,
    );
    const refs = container.querySelectorAll('.ref-chip');
    expect(refs.length).toBeGreaterThan(3);
  });

  it('renders a bold chip ([[**X**]]) as a clean chip in <strong>, no literal asterisks', () => {
    const { container } = render(
      <AdaptiveBullets
        body={'The [[**double empathy problem**]] explains mutual misunderstanding.'}
        parentNodeId="p1"
        onReferenceClick={() => {}}
      />,
    );
    const chip = container.querySelector('.ref-chip');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe('double empathy problem'); // no ** in the label
    expect(chip!.closest('strong')).not.toBeNull();           // rendered bold
    expect(container.textContent).not.toContain('**');         // no leaked asterisks
  });

  it('renders selected phrases with mixed bold/italic formatting and a clean click target', () => {
    const body = applyTermSelection('The **Working** *memory* matters.', '{"terms":["Working memory"]}')!;
    const onClick = vi.fn();
    const { container } = render(<AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={onClick} />);
    const chip = container.querySelector<HTMLElement>('.ref-chip')!;
    expect(chip.textContent).toBe('Working memory');
    expect(chip.querySelector('strong')).toHaveTextContent('Working');
    expect(chip.querySelector('em')).toHaveTextContent('memory');
    expect(container.textContent).not.toMatch(/\[\[|\]\]|\*/);
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledWith('Working memory', expect.anything());
  });

  it.each(['*[[therapy]]*', '_[[therapy]]_', '***[[therapy]]***', '**_[[therapy]]_**', '[[***therapy***]]'])
    ('renders italic term emphasis without exposed markers: %s', (body) => {
      const onClick = vi.fn();
      const { container } = render(<AdaptiveBullets body={`Try ${body} today.`} parentNodeId="p1" onReferenceClick={onClick} />);
      const chip = container.querySelector<HTMLElement>('.ref-chip')!;
      expect(chip.textContent).toBe('therapy');
      expect(chip.closest('em') ?? chip.querySelector('em')).not.toBeNull();
      if (body.includes('**')) expect(chip.closest('strong') ?? chip.querySelector('strong')).not.toBeNull();
      expect(container.textContent).not.toMatch(/[*_]/);
      fireEvent.click(chip);
      expect(onClick).toHaveBeenCalledWith('therapy', expect.anything());
    });

  it('handles nested bold in italic prose without treating ordinary underscores as markup', () => {
    const { container } = render(<AdaptiveBullets body="An *italic phrase with **bold** inside* and file_name; 2 * 3." parentNodeId="p1" onReferenceClick={vi.fn()} />);
    expect(container.querySelector('em strong')).toHaveTextContent('bold');
    expect(container.textContent).toContain('An italic phrase with bold inside and file_name; 2 * 3.');
  });

  it('preserves italic formatting when chunking a multi-sentence span', () => {
    const { container } = render(<AdaptiveBullets body="Before *First sentence. Second sentence.* After." parentNodeId="p1" onReferenceClick={vi.fn()} />);
    const sentences = container.querySelectorAll('.sc-ab-root > .sc-ab-freetext .sc-ab-sentence');
    expect(sentences).toHaveLength(3);
    expect(sentences[0]!.querySelector('em')).toHaveTextContent('First sentence.');
    expect(sentences[1]!.querySelector('em')).toHaveTextContent('Second sentence.');
    expect(container.textContent).not.toContain('*');
  });

  it('keeps selection highlights aligned across Japanese sentence boundaries without spaces', () => {
    const body = '**最初の文。**[[次]]の文。**最後の文。**\n\n- 読書\n  - 本: 情報\n  - 文: 説明';
    const start = body.indexOf('最後');
    seedSourceRelations(body, [selectedArrow('japanese-selection', body, '最後の文。', start, start + '最後の文。'.length, 200)]);
    const { container } = render(<AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={vi.fn()} />);
    const visible = container.querySelector('.sc-ab-root > .sc-ab-freetext')!;
    expect(visible.querySelectorAll('.sc-ab-sentence')).toHaveLength(3);
    expect(visible.querySelector('.source-selection-mark')).toHaveTextContent('最後の文。');
    expect(visible.textContent).toBe('最初の文。次の文。最後の文。');
  });

  it('clicking a collapsed bullet expands it; clicking the expanded bullet again does NOT collapse', async () => {
    const { container } = render(
      <AdaptiveBullets body={REALISTIC} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    const items = container.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item');
    expect(items[0]!.classList.contains('is-active')).toBe(false);
    await userEvent.click(items[0]!);
    expect(items[0]!.classList.contains('is-active')).toBe(true);
    expect(items[0]).toHaveAttribute('data-tip', '');
    // Re-clicking an already-expanded bullet is a no-op — it stays expanded
    // (collapsing was what reset the scroll to the top).
    await userEvent.click(items[0]!);
    expect(items[0]!.classList.contains('is-active')).toBe(true);
  });

  it('clicking a ref-chip does NOT activate the surrounding bullet', async () => {
    const fn = vi.fn();
    const { container } = render(
      <AdaptiveBullets body={REALISTIC} parentNodeId="p1" onReferenceClick={fn} />,
    );
    const refChip = container.querySelector<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item .ref-chip');
    expect(refChip).not.toBeNull();
    await userEvent.click(refChip!);
    expect(fn).toHaveBeenCalled();
    expect(container.querySelectorAll('.sc-ab-root > .sc-ab-list > .sc-ab-item.is-active').length).toBe(0);
  });

  it.each(['click', 'Enter', ' '])('activates a fully visible bullet with %s', (input) => {
    const body = 'Opening.\n\n- Alpha\n  - Detail: First explanation.\n- Beta\n  - Detail: Second explanation.';
    const { container } = render(
      <AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    const items = container.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item');
    expect(items[0]).toHaveAttribute('aria-expanded', 'true');
    expect(items[0]).not.toHaveClass('is-active');
    expect(items[0]).toHaveAttribute('data-tip', 'Click to select bullet');
    if (input === 'click') fireEvent.click(items[0]!);
    else fireEvent.keyDown(items[0]!, { key: input });
    expect(items[0]).toHaveClass('is-active');
    expect(items[0]).toHaveAttribute('data-tip', '');
    expect(useActiveIdxStore.getState().byNodeId.p1).toBe(0);
  });

  // Regression guard for the "saved-collapsed body briefly flashes open
   // on refresh" bug: NodeView relies on onFreeTextH being called
   // BEFORE the first paint so it can compute the collapsed body
   // height for nodes loaded with bulletsCollapsed=true. Both the
   // measurement and the propagation must run in useLayoutEffect
   // (not plain useEffect) so the cascade completes inside the same
   // commit cycle. The functional contract this test guards: the
   // callback is invoked synchronously by the time `render()`
   // returns, with the measured freetext height (40 px from the
   // jsdom mock).
  it('invokes onFreeTextH synchronously on mount with the measured value', () => {
    const onFreeTextH = vi.fn();
    render(
      <AdaptiveBullets
        body={REALISTIC}
        parentNodeId="p1"
        onReferenceClick={() => {}}
        onFreeTextH={onFreeTextH}
      />,
    );
    // The jsdom mock returns height=40 for .sc-ab-freetext above.
    expect(onFreeTextH).toHaveBeenCalled();
    const lastCallArg = onFreeTextH.mock.calls.at(-1)?.[0];
    expect(lastCallArg).toBeGreaterThan(0);
    expect(lastCallArg).toBe(40);
  });

  it('renders each opening-paragraph sentence as its own .sc-ab-sentence block', () => {
    const body = `First sentence about [[glucose]]. Second sentence explains more. Third sentence wraps it up.

- Process
  - Substrate: glucose
  - Enzyme: dehydrogenase
- Conditions
  - Anaerobic: low oxygen
  - pH: around 6`;
    const { container } = render(
      <AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    // Visible freetext (direct child of root) — one block per sentence.
    expect(
      container.querySelectorAll('.sc-ab-root > .sc-ab-freetext .sc-ab-sentence').length,
    ).toBe(3);
    // Hidden measurement clone must match, or node sizing desyncs.
    expect(
      container.querySelectorAll('.sc-ab-measure .sc-ab-freetext .sc-ab-sentence').length,
    ).toBe(3);
    // Chips still render inside a sentence block.
    expect(
      container.querySelector('.sc-ab-root > .sc-ab-freetext .sc-ab-sentence .ref-chip'),
    ).not.toBeNull();
  });

  it('renders the opening paragraph as a single block when sentencePerLine is off', () => {
    useSettingsStore.setState({ sentencePerLine: false });
    const body = `First sentence here. Second sentence follows.

- Process
  - Substrate: glucose
  - Enzyme: dehydrogenase
- Conditions
  - Anaerobic: low oxygen
  - pH: around 6`;
    const { container } = render(
      <AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    // No per-sentence blocks in either render site.
    expect(container.querySelectorAll('.sc-ab-sentence').length).toBe(0);
    // The paragraph text is still rendered intact.
    const ft = container.querySelector('.sc-ab-root > .sc-ab-freetext');
    expect(ft).not.toBeNull();
    expect(ft!.textContent).toContain('First sentence here. Second sentence follows.');
  });

  it('alignment follows justifyParagraph in BOTH broken and unbroken modes', () => {
    const body = `First sentence here. Second sentence follows.

- Process
  - Substrate: glucose
  - Enzyme: dehydrogenase
- Conditions
  - Anaerobic: low oxygen
  - pH: around 6`;
    const align = (c: Element) =>
      (c.querySelector('.sc-ab-root > .sc-ab-freetext') as HTMLElement).style.textAlign;
    const measureAlign = (c: Element) =>
      (c.querySelector('.sc-ab-measure .sc-ab-freetext') as HTMLElement).style.textAlign;

    for (const broken of [true, false]) {
      // Justify ON → both the visible div and the hidden measurement clone justify.
      useSettingsStore.setState({ sentencePerLine: broken, justifyParagraph: true });
      let r = render(<AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />);
      expect(align(r.container)).toBe('justify');
      expect(measureAlign(r.container)).toBe('justify');
      r.unmount();

      // Justify OFF → the language's logical start, in the same mode.
      useSettingsStore.setState({ sentencePerLine: broken, justifyParagraph: false });
      r = render(<AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />);
      expect(align(r.container)).toBe('start');
      expect(measureAlign(r.container)).toBe('start');
      r.unmount();
    }
  });

  it('clicking different bullets swaps which is active', () => {
    const { container } = render(
      <AdaptiveBullets body={REALISTIC} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    const items = () => container.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item');
    act(() => { fireEvent.click(items()[0]!); });
    expect(items()[0]!.classList.contains('is-active')).toBe(true);
    // After click[0], items[1] is cascaded down (not at its natural max),
    // so a click on it should activate it, not deactivate.
    act(() => { fireEvent.click(items()[1]!); });
    expect(items()[0]!.classList.contains('is-active')).toBe(false);
    expect(items()[1]!.classList.contains('is-active')).toBe(true);
  });

  it('marks unexplored chips as part of a selected passage while clicked chips take precedence', () => {
    const body = 'Before selected [[clicked]] and [[unclicked]] after remains.';
    const start = body.indexOf('selected');
    const end = body.indexOf('remains') + 'remains'.length;
    seedSourceRelations(body, [
      selectedArrow(
        'selected-arrow',
        body,
        'selected clicked and unclicked after remains',
        start,
        end,
        200,
      ),
      {
        id: 'chip-arrow', kind: 'auto', fromNodeId: 'p1', toNodeId: 'chip-child', label: 'clicked',
      },
    ]);

    const onReferenceClick = vi.fn();
    const { container } = render(
      <AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={onReferenceClick} />,
    );
    const visible = container.querySelector('.sc-ab-root > .sc-ab-freetext')!;
    const marks = [...visible.querySelectorAll<HTMLElement>('.source-selection-mark')];
    const chips = [...visible.querySelectorAll<HTMLElement>('.ref-chip')];
    const clickedChip = chips.find((chip) => chip.textContent === 'clicked')!;
    const unclickedChip = chips.find((chip) => chip.textContent === 'unclicked')!;

    expect(clickedChip.querySelector('.source-selection-mark')).toBeNull();
    expect(unclickedChip.querySelector('.source-selection-mark')?.textContent).toBe('unclicked');
    expect(unclickedChip.querySelector('.source-selection-mark')?.getAttribute('role')).toBeNull();
    expect(marks.map((mark) => mark.textContent).join('')).toBe('selectedand unclicked after remains');
    expect(marks.every((mark) => mark.dataset.arrowId === 'selected-arrow')).toBe(true);
    expect(marks[0]!.nextSibling?.textContent).toBe(' ');
    expect(clickedChip.nextSibling?.textContent).toBe(' ');

    fireEvent.click(unclickedChip);
    expect(onReferenceClick).toHaveBeenCalledWith('unclicked', { withModifier: false });
  });

  it('assigns active border edges only at logical mark boundaries around clicked-chip gaps', () => {
    const body = 'Before selected [[clicked]] and [[unclicked]] after remains.';
    const start = body.indexOf('selected');
    const end = body.indexOf('remains') + 'remains'.length;
    seedSourceRelations(body, [
      selectedArrow(
        'selected-arrow',
        body,
        'selected clicked and unclicked after remains',
        start,
        end,
        200,
      ),
      {
        id: 'chip-arrow', kind: 'auto', fromNodeId: 'p1', toNodeId: 'chip-child', label: 'clicked',
      },
    ], ['selected-arrow-child']);

    const { container } = render(
      <AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    const visible = container.querySelector('.sc-ab-root > .sc-ab-freetext')!;
    const activeMarks = [...visible.querySelectorAll<HTMLElement>('.source-selection-mark.active')];
    const starts = activeMarks.filter((mark) => mark.classList.contains('source-selection-mark--start'));
    const ends = activeMarks.filter((mark) => mark.classList.contains('source-selection-mark--end'));

    expect(activeMarks.length).toBeGreaterThan(2);
    expect(starts.map((mark) => mark.textContent)).toEqual(['selected', 'and ']);
    expect(ends.map((mark) => mark.textContent)).toEqual(['selected', ' after remains']);
    expect(
      visible.querySelector('.ref-chip.unexplored .source-selection-mark'),
    ).not.toHaveClass('source-selection-mark--start', 'source-selection-mark--end');
  });

  it('merges adjacent active markup fragments into one smooth visual-line outline', () => {
    const body = 'Before selected **bold** after remains.';
    const start = body.indexOf('selected');
    const end = body.indexOf('after') + 'after'.length;
    seedSourceRelations(body, [
      selectedArrow('selected-arrow', body, 'selected bold after', start, end, 200),
    ], ['selected-arrow-child']);

    const { container } = render(
      <AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    const visibleMarks = [...container.querySelectorAll<HTMLElement>('.source-selection-mark.active')]
      .filter((mark) => !mark.closest('.sc-ab-measure'));
    expect(visibleMarks.map((mark) => mark.textContent)).toEqual(['selected ', 'bold', ' after']);

    const lefts = [20, 80, 110];
    const widths = [60, 30, 40];
    visibleMarks.forEach((mark, index) => {
      const left = lefts[index]!;
      Object.defineProperty(mark, 'getClientRects', {
        configurable: true,
        value: () => {
          const width = widths[index]!;
          return [{
            x: left, y: 20, top: 20, left, right: left + width, bottom: 38,
            width, height: 18, toJSON: () => ({}),
          }] as unknown as DOMRectList;
        },
      });
    });

    act(() => window.dispatchEvent(new Event('resize')));

    const outlines = container.querySelectorAll<SVGPathElement>('[data-source-selection-outline]');
    expect(outlines).toHaveLength(1);
    expect(outlines[0]!.getAttribute('d')).toContain('152');

    // Activating a relation transitions its font weight for 100ms. The bold
    // glyphs can grow without changing the root's size, so ResizeObserver does
    // not fire; the outline must explicitly remeasure when that transition ends.
    widths[2] = 48;
    const weightTransition = new Event('transitionend', { bubbles: true });
    Object.defineProperty(weightTransition, 'propertyName', { value: 'font-weight' });
    act(() => visibleMarks[2]!.dispatchEvent(weightTransition));
    expect(outlines[0]!.getAttribute('d')).toContain('160');
  });

  it('shows a selected-text relation through an unexplored whole-title chip', () => {
    const body = 'Opening.\n\n- **Unclicked title**\n  - Detail: text';
    const start = body.indexOf('**Unclicked title**');
    const text = 'Unclicked title';
    seedSourceRelations(body, [{
      id: 'selected-title-arrow',
      kind: 'auto',
      fromNodeId: 'p1',
      toNodeId: 'title-child',
      sourceSelection: {
        sourceVersionCreatedAt: 100,
        createdAt: 200,
        text,
        parts: [{
          sourceField: 'b:0:title',
          start,
          end: start + '**Unclicked title**'.length,
          text,
        }],
      },
    }]);

    const { container } = render(
      <AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    const title = container.querySelector(
      '.sc-ab-root > .sc-ab-list [data-sc-source-field="b:0:title"]',
    )!;

    expect(title.querySelector('.ref-chip.unexplored .source-selection-mark')?.textContent)
      .toBe('Unclicked title');
    expect(title.querySelector('.source-selection-mark')?.getAttribute('role')).toBeNull();
  });

  it('preserves bold markup and gives overlapping characters to the newer relation', () => {
    const body = 'Before **selected overlap words** after.';
    const selectedStart = body.indexOf('selected');
    const overlapStart = body.indexOf('overlap');
    seedSourceRelations(body, [
      selectedArrow(
        'older-arrow', body, 'selected overlap', selectedStart,
        overlapStart + 'overlap'.length, 200,
      ),
      selectedArrow(
        'newer-arrow', body, 'overlap words', overlapStart,
        body.indexOf('words') + 'words'.length, 300,
      ),
    ]);

    const { container } = render(
      <AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    const visible = container.querySelector('.sc-ab-root > .sc-ab-freetext')!;
    const overlap = [...visible.querySelectorAll<HTMLElement>('.source-selection-mark')]
      .find((mark) => mark.textContent?.includes('overlap'));

    expect(visible.querySelector('strong .source-selection-mark')).not.toBeNull();
    expect(overlap?.dataset.arrowId).toBe('newer-arrow');
    expect(visible.textContent).toBe('Before selected overlap words after.');
  });

  it('keeps relation highlights aligned after nested italic delimiters are hidden', () => {
    const body = 'Before ***selected therapy*** after.';
    const start = body.indexOf('selected');
    seedSourceRelations(body, [selectedArrow('italic-arrow', body, 'selected therapy', start, start + 'selected therapy'.length, 200)]);
    const { container } = render(<AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={vi.fn()} />);
    const visible = container.querySelector('.sc-ab-root > .sc-ab-freetext')!;
    expect(visible.querySelector('em strong .source-selection-mark')).toHaveTextContent('selected therapy');
    expect(visible.textContent).toBe('Before selected therapy after.');
  });

  it('wraps the exact in-flight selected fragment in a non-interactive modifying pulse', () => {
    const body = 'Before selected [[chip]] after remains.';
    const start = body.indexOf('selected');
    const end = body.indexOf('remains') + 'remains'.length;
    seedSourceRelations(body, [{
      id: 'chip-arrow', kind: 'auto', fromNodeId: 'p1', toNodeId: 'chip-child', label: 'chip',
    }]);
    useRewriteStore.setState({
      activeByNode: {
        p1: [{
          id: 'rewrite', nodeId: 'p1', kind: 'partial',
          target: {
            kind: 'selection', start, end,
            parts: [{ sourceField: 'ft', start, end, text: 'selected chip after remains' }],
          },
          originalSectionText: 'selected chip after remains',
          abortController: new AbortController(),
        }],
      },
      workingBody: { p1: body },
    });

    const { container } = render(
      <AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    const visible = container.querySelector('.sc-ab-root > .sc-ab-freetext')!;
    const pulses = [...visible.querySelectorAll<HTMLElement>('.source-selection-modifying')];
    expect(pulses.map((pulse) => pulse.textContent).join('')).toBe('selected chip after remains');
    expect(visible.querySelector('.source-selection-modifying .ref-chip')?.textContent).toBe('chip');
    expect(visible.querySelector('.source-selection-modifying[role]')).toBeNull();
  });

  it('pulses multiple selected titles without pulsing their hidden descriptions', () => {
    const body = `Opening.\n\n- Topic\n  - First: hidden alpha\n  - Second: hidden beta`;
    const first = body.indexOf('First');
    const second = body.indexOf('Second');
    seedSourceRelations(body, []);
    useRewriteStore.setState({
      activeByNode: {
        p1: [{
          id: 'rewrite', nodeId: 'p1', kind: 'partial',
          target: {
            kind: 'selection', start: first, end: second + 6,
            parts: [
              { sourceField: 'b:0:c:0:name', start: first, end: first + 5, text: 'First' },
              { sourceField: 'b:0:c:1:name', start: second, end: second + 6, text: 'Second' },
            ],
          },
          originalSectionText: 'First\nSecond',
          abortController: new AbortController(),
        }],
      },
      workingBody: { p1: body },
    });

    const { container } = render(
      <AdaptiveBullets body={body} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    const visible = container.querySelector('.sc-ab-root > .sc-ab-list')!;
    const pulses = [...visible.querySelectorAll<HTMLElement>('.source-selection-modifying')];
    expect(pulses.map((pulse) => pulse.textContent)).toEqual(['First', 'Second']);
    expect(pulses.some((pulse) => pulse.textContent?.includes('hidden'))).toBe(false);
  });
});

describe('AdaptiveBullets — whole-title / whole-name terms (always clickable)', () => {
  const bullet = {
    title: 'The [[Krebs cycle]] in cells',
    children: [{ name: 'Glycolysis', desc: 'the [[first]] step' }],
  };

  it('collapsed bullet (mode 0): the whole title is STILL a clickable whole-term chip', () => {
    const { container } = render(<div>{renderBulletInner(bullet, 0, 'n0', vi.fn())}</div>);
    const titleChips = container.querySelectorAll('.sc-ab-title-text .ref-chip');
    expect(titleChips.length).toBe(1);
    expect(titleChips[0]!.textContent).toBe('The Krebs cycle in cells'); // whole title, markers ignored
  });

  it('fully-open bullet: the title and each child name are whole-term chips', () => {
    const { container } = render(<div>{renderBulletInner(bullet, maxMode(bullet), 'n0', vi.fn())}</div>);
    expect(
      container.querySelector('.sc-ab-title-text .ref-chip')!.textContent,
    ).toBe('The Krebs cycle in cells');
    const nameChip = container.querySelector('.sc-ab-name .ref-chip');
    expect(nameChip).not.toBeNull();
    expect(nameChip!.textContent).toBe('Glycolysis');
  });

  it('inline mode: the title and inline child names are whole-term chips too', () => {
    const b = { title: 'Topic', children: [{ name: 'Alpha', desc: 'a' }, { name: 'Beta', desc: 'b' }] };
    const { container } = render(<div>{renderBulletInner(b, 1, 'n0', vi.fn())}</div>);
    expect(container.querySelector('.sc-ab-title-text .ref-chip')!.textContent).toBe('Topic');
    const inlineChips = container.querySelectorAll('.sc-ab-inline .ref-chip');
    expect(inlineChips.length).toBe(2);
    expect(inlineChips[0]!.textContent).toBe('Alpha');
  });

  it('partially-open described name is a whole-term chip', () => {
    const b = {
      title: 'T',
      children: [
        { name: 'A', desc: 'x' },
        { name: 'B', desc: 'y' },
        { name: 'C', desc: 'z' },
      ],
    };
    // maxMode = 4; m=2 → 1 described + 2 inline (partially open, not focused)
    const { container } = render(<div>{renderBulletInner(b, 2, 'n0', vi.fn())}</div>);
    const nameChip = container.querySelector('.sc-ab-described .sc-ab-name .ref-chip');
    expect(nameChip).not.toBeNull();
    expect(nameChip!.textContent).toBe('A');
  });

  it('a bold whole title renders bold inside the chip with a clean term', () => {
    const b = { title: '[[**One**]]', children: [{ name: 'x', desc: 'y' }] };
    const { container } = render(<div>{renderBulletInner(b, maxMode(b), 'n0', vi.fn())}</div>);
    const chip = container.querySelector('.sc-ab-title-text .ref-chip')!;
    expect(chip.textContent).toBe('One');
    expect(chip.querySelector('strong')).not.toBeNull();
  });

  it('renders parsed italic bullet titles, names and descriptions with clean click targets', () => {
    const b = parseBody('- ***Therapy***\n  - *Therapist:* a *professional*')!.bullets[0]!;
    const onClick = vi.fn();
    const { container } = render(<div>{renderBulletInner(b, maxMode(b), 'n0', onClick)}</div>);
    const title = container.querySelector<HTMLElement>('.sc-ab-title-text .ref-chip')!;
    const name = container.querySelector<HTMLElement>('.sc-ab-name .ref-chip')!;
    expect(title.querySelector('em strong')).toHaveTextContent('Therapy');
    expect(name.querySelector('em')).toHaveTextContent('Therapist');
    expect(container.querySelector('.sc-ab-desc em')).toHaveTextContent('professional');
    expect(container.textContent).not.toContain('*');
    fireEvent.click(title);
    expect(onClick).toHaveBeenCalledWith('Therapy', expect.anything());
    fireEvent.click(name);
    expect(onClick).toHaveBeenCalledWith('Therapist', expect.anything());
  });

  it('descriptions keep their own word-level chips (not whole-term)', () => {
    const { container } = render(<div>{renderBulletInner(bullet, maxMode(bullet), 'n0', vi.fn())}</div>);
    const descChip = container.querySelector('.sc-ab-desc .ref-chip');
    expect(descChip).not.toBeNull();
    expect(descChip!.textContent).toBe('first'); // the [[first]] marker inside the desc
  });
});
