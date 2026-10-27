import { Profiler } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdaptiveBullets } from './AdaptiveBullets';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';
import type { ScatterNode } from '@/store/types';

const noop = () => {};
const BODY = 'An opening paragraph.\n\n- Background\n  - First: ordinary prose\n- Treatment\n  - Method: [[therapy]] helps people';
function node(id: string, body = BODY): ScatterNode {
  return { id, type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: id, body, createdAt: 100, generatedBy: 'root' }], currentVersionIndex: 0 };
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const height = this.classList.contains('sc-ab-root') ? 200
      : this.classList.contains('sc-ab-freetext') ? 40
      : this.classList.contains('sc-ab-item') ? 28 + this.querySelectorAll('.sc-ab-described').length * 22 : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: 480, bottom: height, width: 480, height, toJSON: () => ({}) };
  });
  useActiveIdxStore.setState({ byNodeId: {} });
  useCitationPanelStore.getState().close();
});
afterEach(() => {
  cleanup();
  useGraphStore.getState().setProject(null);
  useGraphStore.temporal.getState().resume();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('does not redraw unrelated bodies when chat history, sources or another node’s fact review changes', () => {
  const nodes = { first: node('first'), second: node('second') };
  const project = createBlankProject('panel rendering', 'first');
  useGraphStore.getState().setProject({ ...project, nodes, selection: [], arrows: {} });
  useGraphStore.temporal.getState().pause();
  const updated = new Set<string>();
  render(<>{Object.values(nodes).map(n => <Profiler key={n.id} id={n.id}
    onRender={id => { updated.add(id); }}>
    <AdaptiveBullets body={n.versions[0]!.body} parentNodeId={n.id} onReferenceClick={noop} />
  </Profiler>)}</>);
  updated.clear();
  act(() => useCitationPanelStore.getState().openConversation('chat'));
  expect([...updated]).toEqual([]);
  act(() => useCitationPanelStore.getState().openWikimedia('chat', 1));
  act(() => useCitationPanelStore.getState().openWikimedia('chat', 2));
  act(() => useCitationPanelStore.getState().openFact('chat', 100, 'chat:0'));
  act(() => useCitationPanelStore.getState().setFactUnit('chat', 'chat:1'));
  act(() => useCitationPanelStore.getState().close());
  expect([...updated]).toEqual([]);
});
it('keeps fact-review highlights live and scoped to the displayed node version', () => {
  const first = node('first');
  first.versions[0]!.factCheck = { complete: {
    schemaVersion: 1, bodyFingerprint: factCheckBodyFingerprint(first.versions[0]!), versionCreatedAt: 100, providerId: 'test', model: 'test',
    startedAt: 1, complete: true, failedUnitIds: [],
    units: [{ id: 'opening:0', order: 0, stage: 'opening', kind: 'sentence',
      text: 'An opening paragraph.', sentenceIndex: 0, state: 'pending' }],
  } };
  first.versions.push({ ...first.versions[0]!, createdAt: 200, factCheck: undefined });
  const nodes = { first, second: node('second') };
  const project = createBlankProject('fact rendering', 'first');
  useGraphStore.getState().setProject({ ...project, nodes, selection: [], arrows: {} });
  const updated = new Set<string>();
  const { container } = render(<>{Object.values(nodes).map(n => <Profiler key={n.id} id={n.id}
    onRender={id => { updated.add(id); }}>
    <section data-owner={n.id}><AdaptiveBullets body={BODY} parentNodeId={n.id} onReferenceClick={noop} /></section>
  </Profiler>)}</>);
  updated.clear();
  act(() => useCitationPanelStore.getState().openFact('first', 100, 'opening:0'));
  expect([...updated]).toEqual(['first']);
  expect(container.querySelector('[data-owner="first"] .fact-active')).toHaveTextContent('An opening paragraph.');
  updated.clear();
  act(() => useCitationPanelStore.getState().setFactUnit('first', 'different-unit'));
  expect([...updated]).toEqual(['first']);
  expect(container.querySelector('.fact-active')).toBeNull();
  expect(container.querySelector('.fact-check-unit')).not.toBeNull();
  act(() => useGraphStore.getState().updateNode('first', { currentVersionIndex: 1 }));
  expect(container.querySelector('.fact-check-unit')).toBeNull();
  updated.clear();
  act(() => useCitationPanelStore.getState().setFactUnit('first', 'opening:0'));
  expect([...updated]).toEqual([]);
  act(() => useGraphStore.getState().updateNode('first', { currentVersionIndex: 0 }));
  expect(container.querySelector('.fact-active')).toHaveTextContent('An opening paragraph.');
  act(() => useCitationPanelStore.getState().close());
  expect(container.querySelector('.fact-check-unit')).toBeNull();
});

it('limits focus work to related bodies, preserving term reveal and selected-passage highlights', () => {
  const nodes = { parent: node('parent'), source: node('source', 'Selected passage.'),
    child: node('child'), passageChild: node('passageChild'), unrelated: node('unrelated') };
  const project = createBlankProject('focus rendering', 'parent');
  useGraphStore.getState().setProject({ ...project, nodes, selection: [], arrows: {
    term: { id: 'term', kind: 'auto', fromNodeId: 'parent', toNodeId: 'child', label: 'therapy' },
    passage: { id: 'passage', kind: 'auto', fromNodeId: 'source', toNodeId: 'passageChild',
      sourceSelection: { sourceVersionCreatedAt: 100, createdAt: 1, text: 'Selected passage',
        parts: [{ sourceField: 'ft', start: 0, end: 16, text: 'Selected passage' }] } },
  } });
  useGraphStore.temporal.getState().pause();
  const updated = new Set<string>();
  const { container } = render(<>{Object.values(nodes).map(n => <Profiler key={n.id} id={n.id}
    onRender={id => { updated.add(id); }}>
    <section data-owner={n.id}><AdaptiveBullets body={n.versions[0]!.body} parentNodeId={n.id} onReferenceClick={noop} /></section>
  </Profiler>)}</>);

  updated.clear();
  act(() => useGraphStore.getState().setSelection(['child']));
  expect([...updated]).toEqual(['parent']);
  expect(useActiveIdxStore.getState().byNodeId.parent).toBe(1);
  expect(container.querySelector('[data-owner="parent"] .ref-chip.active')).toHaveTextContent('therapy');

  updated.clear();
  act(() => useGraphStore.getState().setSelection(['passageChild']));
  expect([...updated].sort()).toEqual(['parent', 'source']);
  expect(container.querySelector('[data-owner="source"] .source-selection-mark.active')).toHaveTextContent('Selected passage');

  updated.clear();
  act(() => useGraphStore.getState().setSelection(['passageChild', 'child']));
  expect([...updated]).toEqual(['source']);
  expect(container.querySelector('.source-selection-mark.active')).toBeNull();
  updated.clear();
  act(() => useGraphStore.getState().setSelection(['passageChild', 'child', 'unrelated']));
  expect(updated.size).toBe(0);
  // Losing focus must not collapse the parent's automatically revealed bullet.
  expect(useActiveIdxStore.getState().byNodeId.parent).toBe(1);
});
