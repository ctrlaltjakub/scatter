import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { FactCheckReport, ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { NodeCitationsPanel } from './NodeCitationsPanel';
import { CitationMarker } from '@/components/node/CitationMarker';
import { useWikimediaTaskStore } from '@/store/useWikimediaTaskStore';
import { useWikimediaGalleryStore } from '@/store/useWikimediaGalleryStore';
import * as imageDiscovery from '@/lib/wikimediaDiscovery';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';

const report: FactCheckReport = {
  schemaVersion: 1,
  bodyFingerprint: 'body',
  versionCreatedAt: 1,
  providerId: 'provider',
  model: 'model',
  startedAt: 1,
  complete: false,
  failedUnitIds: [],
  units: [{
    id: 'opening:0',
    order: 0,
    stage: 'opening',
    kind: 'sentence',
    sentenceIndex: 0,
    text: 'The checked passage.',
    state: 'pending',
  }],
};

describe('NodeCitationsPanel evidence review', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const node: ScatterNode = {
      id: 'n1',
      type: 'term-click',
      position: { x: 0, y: 0 },
      frozen: false,
      versions: [{
        header: 'Evidence',
        body: 'The checked passage.',
        createdAt: 1,
        generatedBy: 'term-click',
        contentType: 'encyclopedic',
        factCheck: { pending: report },
      }],
      currentVersionIndex: 0,
    };
    node.versions[0]!.factCheck!.pending = { ...report, bodyFingerprint: factCheckBodyFingerprint(node.versions[0]!) };
    const project = createBlankProject('evidence', node.id);
    useGraphStore.getState().setProject({
      ...project,
      nodes: { [node.id]: node },
      selection: [node.id],
    });
    useCitationPanelStore.getState().openFact(node.id, 1, 'opening:0');
  });

  afterEach(() => {
    act(() => {
      useCitationPanelStore.getState().close();
      useGraphStore.getState().setProject(null);
    });
    vi.restoreAllMocks();
  });

  it('mounts and follows progressive report updates without an external-store render loop', () => {
    const canvasPointerDown = vi.fn();
    render(
      <div onPointerDown={canvasPointerDown}>
        <NodeCitationsPanel />
      </div>,
    );
    const panel = screen.getByLabelText('Evidence review');
    expect(panel).toBeTruthy();
    expect(screen.getByText('(click passages)')).toBeTruthy();
    expect(useGraphStore.getState().panTo).toMatchObject({
      kind: 'node',
      id: 'n1',
      axis: 'x',
      announceArrival: false,
    });
    expect(screen.getByText('Checking…')).toBeTruthy();
    fireEvent.pointerDown(panel);
    expect(canvasPointerDown).not.toHaveBeenCalled();

    act(() => {
      const project = useGraphStore.getState().project!;
      const node = project.nodes.n1!;
      const version = node.versions[0]!;
      useGraphStore.getState().updateNode(node.id, {
        versions: [{
          ...version,
          factCheck: {
            pending: {
              ...report,
              units: [{
                ...report.units[0]!,
                state: 'complete',
                finding: {
                  verdict: 'supported',
                  explanation: 'A source supports it.',
                  evidence: [],
                },
              }],
            },
          },
        }],
      });
    });

    expect(screen.getByText('Supported')).toBeTruthy();
    expect(screen.getByText('A source supports it.')).toBeTruthy();
  });

  it('keeps historical results readable but explains why old passages are not highlighted', () => {
    const project = useGraphStore.getState().project!;
    const node = project.nodes.n1!;
    useGraphStore.getState().updateNode(node.id, { versions: [{ ...node.versions[0]!, factCheck: { pending: report } }] });
    render(<NodeCitationsPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('This saved check no longer matches the current text layout. Run a new check to highlight passages.');
    expect(screen.getByText('“The checked passage.”')).toBeVisible();
    expect(screen.queryByText('(click passages)')).not.toBeInTheDocument();
  });

  it('uses a double-width selectable panel with Scatter cursors', () => {
    const css = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');
    // The double-class selector must outrank the later generic `.side-panel`
    // width declaration; a lone `.fact-review-panel` rule is overridden by
    // source order and leaves the panel at 248px in the browser.
    const rule = /\.side-panel\.fact-review-panel\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('width: 372px');
    expect(rule).toContain('cursor: var(--cur-pointer)');
    expect(rule).toContain('user-select: text');
    const scrollRule = /\.fact-review-scroll\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(scrollRule).toContain('cursor: var(--cur-text)');
    expect(scrollRule).toContain('user-select: text');
  });

  it('separates internal and web evidence while preserving one shared number sequence', () => {
    const project = useGraphStore.getState().project!;
    const node = project.nodes.n1!;
    useGraphStore.getState().updateNode('n1', {
      versions: [{
        ...node.versions[0]!,
        body: 'Local evidence (1). Web evidence ⟦2⟧.',
        internalSources: [{
          n: 1,
          sourceId: 'source-1',
          revisionId: 'revision-1',
          passageId: 'page-4:0',
          sourceTitle: 'Project manual',
          page: 4,
          excerpt: 'The exact project passage.',
        }],
        sources: [{ n: 2, url: 'https://example.com/evidence', title: 'Web evidence' }],
      }],
    });
    render(<><CitationMarker parentNodeId="n1" n={1} internal /><CitationMarker parentNodeId="n1" n={2} /><NodeCitationsPanel /></>);
    expect(screen.getByText('(1)')).toBeTruthy();
    expect(screen.getByText('[2]')).toBeTruthy();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Source 2' })).toHaveAttribute(
      'href',
      'https://example.com/evidence',
    );
  });
});

describe('NodeCitationsPanel Wikimedia review', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const node: ScatterNode = {
      id: 'n1', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [{
        header: 'Cells', body: 'Cells contain organelles.', createdAt: 2,
        generatedBy: 'term-click', contentType: 'encyclopedic',
        wikimediaImages: {
          schemaVersion: 1, bodyFingerprint: 'body', providerId: 'provider', model: 'model',
          searchedAt: 2, resultLimit: 5,
          results: [{
            pageId: 1, fileTitle: 'File:Cell.png',
            filePageUrl: 'https://commons.wikimedia.org/wiki/File:Cell.png',
            thumbnailUrl: 'https://upload.wikimedia.org/cell.png',
            originalUrl: 'https://upload.wikimedia.org/original.png',
            caption: 'Cell structure', license: 'CC BY-SA 4.0',
            relevance: 'The labeled cell makes the organelles in this node spatially concrete.',
            creditLine: 'Researcher / Wikimedia Commons',
          }],
        },
      }],
      currentVersionIndex: 0,
    };
    const project = createBlankProject('images', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { n1: node }, selection: ['n1'] });
    useCitationPanelStore.getState().openWikimedia('n1', 2);
  });

  afterEach(() => {
    act(() => {
      useCitationPanelStore.getState().close();
      useGraphStore.getState().setProject(null);
      useWikimediaTaskStore.setState({ tasks: {} });
      useWikimediaGalleryStore.getState().close();
    });
    vi.restoreAllMocks();
  });

  it.each([0, 1, 2])('pluralizes image counts for %s results in automatic and manual search', (count) => {
    const node = useGraphStore.getState().project!.nodes.n1!;
    const version = node.versions[0]!;
    const result = version.wikimediaImages!.results[0]!;
    const results = Array.from({ length: count }, (_, index) => ({ ...result, pageId: index + 1, fileTitle: `File:Cell-${index + 1}.png` }));
    useGraphStore.getState().updateNode(node.id, { versions: [{ ...version,
      wikimediaImages: { ...version.wikimediaImages!, results },
    }] });
    render(<NodeCitationsPanel />);
    expect(screen.getByText(`${count} AI suggestion${count === 1 ? '' : 's'} · Search above queries catalogs directly`)).toBeInTheDocument();

    act(() => useGraphStore.getState().updateNode(node.id, { versions: [{ ...version,
      imageRecommendations: {
        schemaVersion: 2, bodyFingerprint: 'body', searchedAt: 3, resultLimit: 48,
        mode: 'manual', manualQuery: 'Cells', sourceOutcomes: [], results,
      },
    }] }));
    expect(screen.getByText(`Direct catalog search · no AI · ${count} result${count === 1 ? '' : 's'}`)).toBeInTheDocument();
  });

  it('shows relevance, credits, and the explicit spawn action, then opens the gallery', () => {
    render(<NodeCitationsPanel />);
    expect(screen.getByText('Image suggestions')).toBeTruthy();
    expect(screen.getByText('The labeled cell makes the organelles in this node spatially concrete.')).toBeTruthy();
    expect(screen.getByText('Cell structure')).toHaveAttribute('title', 'Cell structure');
    expect(screen.getByText(/Researcher \/ Wikimedia Commons/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Wikimedia' })).toHaveAttribute(
      'href',
      'https://commons.wikimedia.org/wiki/File:Cell.png',
    );
    expect(screen.getByRole('button', { name: 'Spawn media node' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Redo Wikimedia search/i })).toBeNull();
    const preview = screen.getByRole('button', { name: 'Cell structure' });
    fireEvent.click(preview);
    expect(useWikimediaGalleryStore.getState()).toMatchObject({ open: true, nodeId: 'n1', index: 0 });
  });

  it('submits the typed text as a direct query and offers catalog continuation', () => {
    const search = vi.spyOn(imageDiscovery, 'startWikimediaDiscovery').mockResolvedValue();
    const node = useGraphStore.getState().project!.nodes.n1!;
    useGraphStore.getState().updateNode(node.id, { versions: [{ ...node.versions[0]!, imageRecommendations: {
      schemaVersion: 2, bodyFingerprint: 'body', searchedAt: 3, resultLimit: 48, mode: 'manual', manualQuery: 'Neuron',
      sourceOutcomes: [], results: [], next: { wikimedia: 24, openverse: 2 },
    } }] });
    render(<NodeCitationsPanel />);
    const input = screen.getByRole('textbox', { name: 'Search free images' });
    fireEvent.change(input, { target: { value: '"House of Leaves"' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search images' }));
    expect(search).toHaveBeenLastCalledWith('n1', 2, { rerun: true, manualQuery: '"House of Leaves"', loadMore: false });
    fireEvent.submit(input.closest('form')!);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith('n1', 2, { rerun: true, manualQuery: '"House of Leaves"', loadMore: false });
    fireEvent.click(screen.getByRole('button', { name: 'Load more images' }));
    expect(search).toHaveBeenLastCalledWith('n1', 2, { rerun: true, manualQuery: 'Neuron', loadMore: true });
    expect(screen.queryByText(/AI-written relevance/)).not.toBeInTheDocument();
  });

  it('keeps the current images visible while another result page is loading', () => {
    useWikimediaTaskStore.getState().setTask('n1:2', { running: true, loadingMore: true, startedAt: 1 });
    render(<NodeCitationsPanel />);
    expect(screen.getByText('Cell structure')).toBeInTheDocument();
  });

  it('stops the current search from the panel', () => {
    const stop = vi.spyOn(imageDiscovery, 'stopWikimediaDiscovery').mockImplementation(() => {});
    useWikimediaTaskStore.getState().setTask('n1:2', { running: true, startedAt: 1 });
    render(<NodeCitationsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop image search' }));
    expect(stop).toHaveBeenCalledWith('n1', 2);
  });

  it('resets the query when opening a different node without closing the image panel first', () => {
    render(<NodeCitationsPanel />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search free images' }), { target: { value: 'Old query' } });
    act(() => {
      const project = useGraphStore.getState().project!;
      const other: ScatterNode = { ...project.nodes.n1!, id: 'n2', versions: [{ ...project.nodes.n1!.versions[0]!, header: 'Neurons', createdAt: 3, wikimediaImages: undefined }] };
      useGraphStore.setState({ project: { ...project, nodes: { ...project.nodes, n2: other }, selection: ['n2'] } });
      useCitationPanelStore.getState().openWikimedia('n2', 3);
    });
    expect(screen.getByRole('textbox', { name: 'Search free images' })).toHaveValue('Neurons');
  });

  it('uses all available panel width and scrolls overflowing recommendations', () => {
    const css = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');
    const listRule = /\.wikimedia-panel \.citations-list\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    // Preserve the cards' intrinsic content sizing while the list shrinks
    // inside the definite runtime viewport and owns the overflow scrolling.
    expect(listRule).toContain('flex: 1 1 auto');
    expect(listRule).not.toContain('flex: 1 1 0');
    expect(listRule).toContain('width: 100%');
    expect(listRule).toContain('min-width: 0');
    expect(listRule).toContain('overflow-y: auto');
    const resultRule = /\.wikimedia-result\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(resultRule).toContain('flex: 0 0 auto');
    const imageRule = /\.wikimedia-result-preview img\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(imageRule).toContain('width: 100%');
    expect(imageRule).toContain('height: auto');
    expect(imageRule).not.toContain('max-height');
    const captionRule = /\.wikimedia-result-caption\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(captionRule).toContain('display: block');
    expect(captionRule).not.toContain('-webkit-line-clamp');
    expect(captionRule).toContain('white-space: normal');
    expect(captionRule).toContain('text-wrap: wrap');
    expect(captionRule).toContain('overflow-wrap: anywhere');
    expect(captionRule).toContain('word-break: break-word');
    expect(captionRule).toContain('max-width: 100%');
    expect(captionRule).toContain('max-height: calc(3.9em + 7px)');
    expect(captionRule).toContain('overflow: hidden');
    const panelRule = /\.side-panel\.wikimedia-panel\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(panelRule).toContain('cursor: var(--cur-pointer)');
    expect(panelRule).toContain('user-select: text');
    expect(captionRule).toContain('cursor: var(--cur-text)');
    const relevanceRule = /\.wikimedia-result-relevance\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(relevanceRule).toContain('cursor: var(--cur-text)');
  });

  it('assigns a definite panel viewport so metadata and actions scroll with the images', () => {
    render(
      <>
        <div data-node-id="n1" />
        <NodeCitationsPanel />
      </>,
    );
    const panel = screen.getByText('Image suggestions').closest('.wikimedia-panel');
    expect(panel).toHaveStyle({ height: '320px', maxHeight: '320px' });
  });

  it('hides the previous list behind skeletons while a clean rerun is active', () => {
    useWikimediaTaskStore.getState().setTask('n1:2', { running: true, startedAt: 1 });
    const { container } = render(<NodeCitationsPanel />);
    expect(screen.queryByText('Cell structure')).toBeNull();
    expect(container.querySelectorAll('.wikimedia-skeleton')).toHaveLength(3);
  });

  it('labels Openverse results and reports a partial catalog rate limit', () => {
    const project = useGraphStore.getState().project!;
    const node = project.nodes.n1!;
    const version = node.versions[0]!;
    useGraphStore.getState().updateNode('n1', {
      versions: [{
        ...version,
        imageRecommendations: {
          schemaVersion: 2,
          bodyFingerprint: 'body', providerId: 'provider', model: 'model',
          searchedAt: 3, resultLimit: 5,
          sourceOutcomes: [
            { source: 'wikimedia', status: 'rate-limited' },
            { source: 'openverse', status: 'success' },
          ],
          results: [{
            source: 'openverse', sourceId: 'ov-1',
            landingPageUrl: 'https://example.org/work/1',
            thumbnailUrl: 'https://api.openverse.org/thumb/1',
            originalUrl: 'https://example.org/original.jpg',
            caption: 'Therapy chair', relevance: 'The chair makes the exercise concrete.',
            creator: 'Jane Doe', license: 'CC BY 4.0', creditLine: 'Jane Doe / CC BY 4.0',
          }],
        },
      }],
    });

    render(<NodeCitationsPanel />);

    expect(screen.getByText('Wikimedia rate-limited')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Openverse' })).toHaveAttribute(
      'href', 'https://example.org/work/1',
    );
  });
});
