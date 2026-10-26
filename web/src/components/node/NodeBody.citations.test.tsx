import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { buildSources, placeCitationMarkersReliable, renumberCitations } from '@/lib/citations';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { applyTermSelection } from '@/lib/termMarking';
import { NodeBody } from './NodeBody';

const FIRST = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE1RGDAg0zcigRyLHWAGRQ4fj5259nNPZEDyk1JQctb6vxGHHQifyjF4Km28ay13X-M0C-TNrX3A81xlCaS4Npc7QRScEftHzwKuk9D2cBK8ZHeTbYBvD3orjG1dAmESvFMOgsNFi7tiOyPtp73NbINg064L__iUt5jJbb8u2uqcHknbBtCgjuvMJ1tPrpln0jyFgkr13VSYg==';
const SECOND = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEGhLd4Z5bsxEAJ7OgzBg2kUWNLNxPxILashGl6T6TX37DKQm_xonUF6flPOuSXWIlFJemmtiON-BoUQ_UlDeygDVkXwzxDgGtYdLf-9OJ-n';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function normalizedReportedBody() {
  const raw = `El Niño has **indirect effects** in the **Pacific basin** ${FIRST}.\n\n`
    + `These **teleconnections** involve the **North Atlantic Oscillation** ${SECOND}.\n\n`
    + '- Mechanisms\n'
    + '  - Atmospheric coupling: The response travels through global circulation.\n'
    + '  - Seasonal timing: The strongest signal usually arrives in winter.';
  const citations = [FIRST, SECOND].map((url, index) => ({
    url,
    title: index ? 'North Atlantic source' : 'Pacific source',
    startIndex: 2 + index,
    endIndex: 3 + index,
    offsetKind: 'citation-label' as const,
  }));
  const sources = buildSources(citations);
  return renumberCitations(placeCitationMarkersReliable(raw, citations, sources), sources);
}

describe('NodeBody citation rendering', () => {
  beforeEach(() => {
    useRewriteStore.setState({ activeByNode: {}, workingBody: {} });
    useActiveIdxStore.setState({ byNodeId: {} });
    const normalized = normalizedReportedBody();
    const node: ScatterNode = {
      id: 'n0', type: 'root', position: { x: 0, y: 0 }, frozen: false,
      versions: [{
        header: 'European influence', body: normalized.body, sources: normalized.sources,
        createdAt: 0, generatedBy: 'root',
      }],
      currentVersionIndex: 0,
    };
    const project = createBlankProject('citation render', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
  });

  it('renders only clickable Scatter keys, never raw Gemini redirect URLs', () => {
    const body = useGraphStore.getState().project!.nodes.n0!.versions[0]!.body;
    const { container } = render(
      <NodeBody body={body} parentNodeId="n0" selected={false} onReferenceClick={() => {}} />,
    );
    expect(screen.getByRole('link', { name: 'Source 1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Source 2' })).toBeTruthy();
    expect(container.textContent).not.toContain('vertexaisearch');
    expect(container.textContent).toContain('[1]');
    expect(container.textContent).toContain('[2]');
  });

  it('leaves search suggestions to the detached panel, never inside the node body', () => {
    const node = useGraphStore.getState().project!.nodes.n0!;
    useGraphStore.getState().updateNode('n0', { versions: [{ ...node.versions[0]!,
      googleSearchSuggestions: ['<div>Google Search</div>'] }] });
    const { container } = render(<NodeBody body={node.versions[0]!.body} parentNodeId="n0"
      selected={false} onReferenceClick={() => {}} />);
    expect(container.querySelector('iframe')).toBeNull();
    act(() => useGraphStore.getState().updateNode('n0', { bulletsCollapsed: true }));
    expect(container.querySelector('iframe')).toBeNull();
    act(() => useGraphStore.getState().updateNode('n0', { bulletsCollapsed: false }));
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('renders the reported cite fragment as source buttons after term marking, without exposing tags', () => {
    const sources = [3, 4, 5].map(n => ({ n, url: `https://example.com/source-${n}` }));
    const placed = placeCitationMarkersReliable('A cache improves latency \\<cite>[3]\\</cite>[4][5].', [], sources);
    const marked = applyTermSelection(placed, JSON.stringify({ terms: ['cache', 'latency'] }))!;
    const normalized = renumberCitations(marked, sources);
    const node = useGraphStore.getState().project!.nodes.n0!;
    useGraphStore.getState().updateNode('n0', { versions: [{ ...node.versions[0]!, body: normalized.body, sources: normalized.sources }] });
    const { container } = render(<NodeBody body={normalized.body} parentNodeId="n0" selected={false} onReferenceClick={() => {}} />);
    for (const n of [1, 2, 3]) expect(screen.getByRole('link', { name: `Source ${n}` })).toBeInTheDocument();
    expect(container.textContent).not.toContain('cite>');
    expect(container.textContent).not.toContain('\\');
    expect(normalized.body).toBe('A [[cache]] improves [[latency]]⟦1⟧⟦2⟧⟦3⟧.');
  });

  it('renders Exa-backed Gemini URL labels as source buttons, not visible URLs', () => {
    const first = 'https://repository.library.noaa.gov/view/noaa/21547';
    const second = 'https://www.metoffice.gov.uk/about-us/news-and-media/media-centre/weather-and-climate-news/2024/enso-lagged-response';
    const raw = `El Niño has an **indirect European influence** [${first}] and a **lagged winter response** [${second}].\n\n`
      + '- Atmospheric teleconnections\n'
      + '  - NAO coupling: Pressure patterns shift across Europe.\n'
      + '  - Lagged response: Effects can appear the following winter.\n'
      + '- Regional variation\n'
      + '  - Northern Europe: Outcomes depend on interacting circulation patterns.\n'
      + '  - Southern Europe: Rainfall responses differ by season.';
    const citations = [
      { url: first, title: 'NOAA repository', offsetKind: 'citation-label' as const },
      { url: second, title: 'Met Office', offsetKind: 'citation-label' as const },
    ];
    const sources = buildSources(citations);
    const normalized = renumberCitations(
      placeCitationMarkersReliable(raw, citations, sources),
      sources,
    );
    const project = useGraphStore.getState().project!;
    const node = project.nodes.n0!;
    useGraphStore.getState().setProject({
      ...project,
      nodes: {
        ...project.nodes,
        n0: {
          ...node,
          versions: [{ ...node.versions[0]!, body: normalized.body, sources: normalized.sources }],
        },
      },
    });

    const { container } = render(
      <NodeBody body={normalized.body} parentNodeId="n0" selected={false} onReferenceClick={() => {}} />,
    );
    expect(screen.getByRole('link', { name: 'Source 1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Source 2' })).toBeTruthy();
    expect(container.textContent).not.toContain('https://');
    expect(container.textContent).not.toContain('repository.library.noaa.gov');
    expect(container.textContent).toContain('[1]');
    expect(container.textContent).toContain('[2]');
  });

  it('renders internal keys first and web keys after them without duplicate numbers', () => {
    const project = useGraphStore.getState().project!;
    const node = project.nodes.n0!;
    const body = `A project passage supports this claim (1).

A web page supports this other claim ⟦2⟧.`;
    useGraphStore.getState().setProject({
      ...project,
      nodes: {
        ...project.nodes,
        n0: {
          ...node,
          versions: [{
            ...node.versions[0]!,
            body,
            internalSources: [{
              n: 1,
              sourceId: 'source-1',
              revisionId: 'revision-1',
              passageId: 'passage-1',
              sourceTitle: 'Project source',
              excerpt: 'A project passage supports this claim.',
            }],
            sources: [{ n: 2, url: 'https://example.com/web', title: 'Web source' }],
          }],
        },
      },
    });

    const { container } = render(
      <NodeBody body={body} parentNodeId="n0" selected={false} onReferenceClick={() => {}} />,
    );

    expect(screen.getByRole('button', { name: 'Project source 1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Source 2' })).toBeTruthy();
    expect(container.textContent).toContain('(1)');
    expect(container.textContent).toContain('[2]');
    expect(container.textContent).not.toContain('[1]');
  });
});
