import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Group, ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { NodeSidePanel } from './NodeSidePanel';
import { DEFAULT_SETTINGS } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import * as generation from '@/lib/generate';
import * as imageDiscovery from '@/lib/wikimediaDiscovery';
import { useWikimediaTaskStore, wikimediaTaskKey } from '@/store/useWikimediaTaskStore';
import { createChatNode } from '@/lib/chat/model';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';

const rootNode: ScatterNode = {
  id: 'root',
  type: 'root',
  position: { x: 0, y: 0 },
  frozen: false,
  versions: [{ header: 'Root', body: 'Root.', createdAt: 0, generatedBy: 'root' }],
  currentVersionIndex: 0,
};

function textNode(id: string, groupId?: string): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x: 100, y: 100 },
    frozen: false,
    groupId,
    versions: [{
      header: 'Selected node',
      body: 'Opening.\n\n- **First**\n  - Detail.',
      createdAt: 0,
      generatedBy: 'term-click',
      contentType: 'encyclopedic',
    }],
    currentVersionIndex: 0,
  };
}

const groups: Record<string, Group> = {
  z: { id: 'z', name: 'zoology', color: '#78a66b', gravitate: false },
  a: { id: 'a', name: 'Alpha studies', color: '#8d74bf', gravitate: false },
  long: {
    id: 'long',
    name: 'Historical theories of memory consolidation and reconsolidation across different research periods',
    color: '#bc8252',
    gravitate: false,
  },
};

function seed(opts: {
  groupedNode?: boolean;
  groupedChild?: boolean;
  withChild?: boolean;
  withSources?: boolean;
  withWikimedia?: boolean;
} = {}) {
  const selected = textNode('selected', opts.groupedNode ? 'z' : undefined);
  if (opts.withSources) {
    selected.versions[0] = {
      ...selected.versions[0]!,
      sources: [{ n: 1, url: 'https://example.com/source', title: 'Source' }],
    };
  }
  if (opts.withWikimedia) {
    selected.versions[0] = {
      ...selected.versions[0]!,
      wikimediaImages: {
        schemaVersion: 1,
        bodyFingerprint: 'body',
        providerId: 'image-provider',
        model: 'text-model',
        searchedAt: 1,
        resultLimit: 5,
        results: [{
          pageId: 1,
          fileTitle: 'File:Memory.png',
          filePageUrl: 'https://commons.wikimedia.org/wiki/File:Memory.png',
          thumbnailUrl: 'https://upload.wikimedia.org/memory.png',
          originalUrl: 'https://upload.wikimedia.org/memory-original.png',
          caption: 'Memory diagram',
          relevance: 'The diagram makes the process described by this node visible.',
          license: 'CC BY 4.0',
          creditLine: 'Contributor / Wikimedia Commons',
        }],
      },
    };
  }
  const nodes: Record<string, ScatterNode> = { root: rootNode, selected };
  const arrows = {} as Record<string, { id: string; fromNodeId: string; toNodeId: string; kind: 'auto' }>;
  if (opts.withChild) {
    nodes.child = textNode('child', opts.groupedChild ? 'a' : undefined);
    arrows.edge = { id: 'edge', fromNodeId: 'selected', toNodeId: 'child', kind: 'auto' };
  }
  const project = createBlankProject('panel', rootNode.id);
  useGraphStore.getState().setProject({
    ...project,
    rootNodeId: rootNode.id,
    nodes,
    arrows,
    groups,
    selection: [selected.id],
  });
  useGraphStore.temporal.getState().pause();
}

function renderPanel(opts: Parameters<typeof seed>[0] = {}) {
  seed(opts);
  return render(<NodeSidePanel />);
}

describe('NodeSidePanel disclosures and groups', () => {
  beforeEach(() => {
    useWikimediaTaskStore.setState({ tasks: {} });
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    useSettingsStore.setState({
      ...DEFAULT_SETTINGS,
      providers: [{ id: 'image-provider', preset: 'openai', apiKey: 'key', enabledModels: ['text-model'] }],
      activeModelRef: { providerId: 'image-provider', model: 'text-model' },
      imageModelRef: { providerId: 'image-provider', model: 'gpt-image-2' },
    });
    useImageModelCatalogStore.getState().setCatalog('image-provider', [{ id: 'gpt-image-2' }]);
    useModelCatalogStore.getState().setCatalog('image-provider', [{
      id: 'text-model', caps: { vision: true, textOutput: true },
    }]);
  });

  afterEach(() => {
    useActiveIdxStore.getState().replaceAll([]);
    useImageModelCatalogStore.getState().clear();
    useModelCatalogStore.getState().clear();
    useCitationPanelStore.getState().close();
    vi.restoreAllMocks();
  });

  it.each(['encyclopedic', 'explain', 'media', 'interactive', 'chat', 'answer', 'markdown'] as const)(
    'puts Add node first below the icon row for %s nodes', (kind) => {
      seed();
      const graph = useGraphStore.getState();
      const node = graph.project!.nodes.selected!;
      if (kind === 'chat') graph.updateNode(node.id, createChatNode({
        id: node.id, createdAt: 1, position: node.position, bodyHeight: 300,
      }));
      else graph.updateNode(node.id, { versions: [{ ...node.versions[0]!,
        contentType: kind === 'markdown' ? 'answer' : kind, markdownNote: kind === 'markdown' }] });
      const { container } = render(<NodeSidePanel />);
      const add = screen.getByRole('button', { name: 'Add node' });
      expect(container.querySelector('.versions-row')?.nextElementSibling).toBe(add);
      expect(add).toHaveClass('side-action-add-node');
      expect(screen.getAllByRole('button', { name: 'Add node' })).toHaveLength(1);
    },
  );

  it('keeps Markdown Edit second and mutually exclusive with Add node and Group', () => {
    seed();
    const node = useGraphStore.getState().project!.nodes.selected!;
    useGraphStore.getState().updateNode(node.id, { versions: [{ ...node.versions[0]!, contentType: 'answer', markdownNote: true }] });
    render(<NodeSidePanel />);
    const add = screen.getByRole('button', { name: 'Add node' });
    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(add.nextElementSibling).toBe(edit);
    fireEvent.click(add);
    fireEvent.click(edit);
    expect(add).toHaveAttribute('aria-expanded', 'false');
    expect(edit).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Edit header' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit or export text' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));
    expect(edit).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Edit or export text' })).toBeNull();
  });

  it('offers manual free-image search when automatic discovery is off, then show/hide', () => {
    useSettingsStore.setState({ autoFreeImages: false });
    const search = vi.spyOn(imageDiscovery, 'startWikimediaDiscovery').mockImplementation(async (id, createdAt) => {
      useWikimediaTaskStore.getState().setTask(wikimediaTaskKey(id, createdAt), { running: true, startedAt: 1 });
    });
    renderPanel();
    expect(search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Search for free images' }));
    expect(search).not.toHaveBeenCalled();
    expect(useCitationPanelStore.getState().mode).toBe('wikimedia');
    fireEvent.click(screen.getByRole('button', { name: 'Hide free images' }));
    expect(screen.getByRole('button', { name: 'Search for free images' })).toBeInTheDocument();
  });

  it('offers manual free-image search for explain nodes even when automatic discovery is on', () => {
    seed();
    const graph = useGraphStore.getState();
    const node = graph.project!.nodes.selected!;
    graph.updateNode(node.id, { versions: [{ ...node.versions[0]!, contentType: 'explain' }] });
    const search = vi.spyOn(imageDiscovery, 'startWikimediaDiscovery').mockResolvedValue();
    render(<NodeSidePanel />);
    expect(search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Search for free images' }));
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Hide free images' })).toBeInTheDocument();
  });

  it.each(['encyclopedic', 'explain'] as const)('places %s conversion last inside Edit and preserves the established generation route', (contentType) => {
    seed();
    const graph = useGraphStore.getState();
    const node = graph.project!.nodes.selected!;
    graph.updateNode(node.id, { versions: [{ ...node.versions[0]!, contentType }] });
    const convert = vi.spyOn(generation, 'retypeNodeToText').mockResolvedValue();
    render(<NodeSidePanel />);
    const target = contentType === 'encyclopedic' ? 'explain' : 'encyclopedic';
    const name = `Convert to ${target} node`;
    expect(screen.queryByRole('button', { name })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const button = screen.getByRole('button', { name });
    expect(button.parentElement?.lastElementChild).toBe(button);
    fireEvent.click(button);
    expect(convert).toHaveBeenCalledWith(node.id, target);
    act(() => useGraphStore.getState().updateNode(node.id, { generating: true }));
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(convert).toHaveBeenCalledTimes(1);
    act(() => useGraphStore.getState().setSelection(['root']));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('button', { name: /Convert to/ })).toBeNull();
  });

  it('starts closed, uses disclosure chevrons, and keeps only one section open', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Fact-check' })).toBeTruthy();
    const textTools = screen.getByRole('button', { name: 'Edit' });
    const group = screen.getByRole('button', { name: 'Group' });
    expect(textTools).toHaveAttribute('aria-expanded', 'false');
    expect(textTools.querySelector('.lucide-chevron-right')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Expand whole' })).toBeNull();

    fireEvent.click(textTools);
    expect(textTools).toHaveAttribute('aria-expanded', 'true');
    expect(textTools.querySelector('.lucide-chevron-down')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand whole' })).toBeTruthy();

    fireEvent.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(textTools).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Expand whole' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add to new group' })).toBeTruthy();
  });

  it('offers branch project creation only for a settled non-root text branch', () => {
    renderPanel({ withChild: true });
    const action = screen.getByRole('button', { name: 'Create project from branch' });
    expect(action).toHaveAttribute('aria-disabled', 'false');
    expect(action.querySelector('.lucide-file-symlink')).toBeTruthy();
    expect(action.parentElement?.lastElementChild).toBe(action);

    act(() => useGraphStore.getState().updateNode('child', { generating: true }));
    expect(action).toHaveAttribute('aria-disabled', 'true');
    expect(action).toHaveAttribute(
      'data-tip',
      'Wait for every node in this branch to finish generating.',
    );

    act(() => useGraphStore.getState().setSelection(['root']));
    expect(screen.queryByRole('button', { name: 'Create project from branch' })).toBeNull();
  });

  it('uses one Wikimedia-style disclosure to show results and reveal extra actions', () => {
    seed();
    const project = useGraphStore.getState().project!;
    const selected = project.nodes.selected!;
    selected.versions[0] = {
      ...selected.versions[0]!,
      factCheck: {
        complete: {
          schemaVersion: 1,
          bodyFingerprint: 'body',
          versionCreatedAt: 0,
          providerId: 'image-provider',
          model: 'text-model',
          startedAt: 1,
          completedAt: 2,
          complete: true,
          failedUnitIds: [],
          units: [{
            id: 'opening:0', order: 0, stage: 'opening', kind: 'sentence',
            text: 'Opening.', state: 'complete',
            finding: { verdict: 'supported', explanation: 'Supported.', evidence: [] },
          }],
        },
      },
    };
    render(<NodeSidePanel />);

    const show = screen.getByRole('button', { name: 'Show fact-check results' });
    expect(screen.queryByRole('button', { name: 'Show results' })).toBeNull();
    fireEvent.click(show);
    expect(useCitationPanelStore.getState().mode).toBe('fact-check');
    const hide = screen.getByRole('button', { name: 'Hide fact-check results' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(hide.querySelector('.lucide-chevron-down')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hide results' })).toBeNull();

    fireEvent.click(hide);
    expect(useCitationPanelStore.getState().mode).toBeNull();
    expect(screen.getByRole('button', { name: 'Show fact-check results' })).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([true, false])('does not promise to resume a check from a different layout (current=%s)', current => {
    seed();
    const selected = useGraphStore.getState().project!.nodes.selected!;
    const version = selected.versions[0]!;
    version.factCheck = { pending: { schemaVersion: 1,
      bodyFingerprint: current ? factCheckBodyFingerprint(version) : 'old-punctuation-boundaries',
      versionCreatedAt: version.createdAt, providerId: 'test', model: 'test', startedAt: 1,
      complete: false, failedUnitIds: [], units: [{ id: 'opening:0', order: 0, stage: 'opening', kind: 'sentence', text: 'Opening.', state: 'pending' }] } };
    render(<NodeSidePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show fact-check results' }));
    expect(screen.getByRole('button', { name: current ? 'Continue check' : 'Check again' })).toHaveAttribute('data-tip',
      current ? 'Retry only unfinished passages' : 'Run a fresh evidence check while retaining these results');
  });

  it('closes the open disclosure when selection moves to another node', () => {
    renderPanel({ withChild: true });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-expanded', 'true');

    act(() => useGraphStore.getState().setSelection(['child']));

    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Expand whole' })).toBeNull();
  });

  it('keeps media actions outside Edit and includes a direct header action', () => {
    seed();
    const project = useGraphStore.getState().project!;
    const mediaNode: ScatterNode = {
      ...project.nodes.selected!,
      type: 'media',
      versions: [{
        ...project.nodes.selected!.versions[0]!,
        body: '',
        contentType: 'media',
        generatedBy: 'media',
      }],
    };
    useGraphStore.getState().setProject({
      ...project,
      nodes: { ...project.nodes, selected: mediaNode },
    });
    render(<NodeSidePanel />);

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Group' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Edit header' })).toHaveClass('side-action');
  });

  it('turns the reload control into regenerate only for generated images', () => {
    seed();
    const project = useGraphStore.getState().project!;
    const selected = project.nodes.selected!;
    const mediaNode: ScatterNode = {
      ...selected,
      type: 'media',
      versions: [{
        header: 'Image: memory', body: '', createdAt: 2, generatedBy: 'media', contentType: 'media',
        media: { source: 'asset', kind: 'image', assetId: 'generated' },
        imageGeneration: {
          prompt: 'the full image prompt', promptSource: 'media-prompt', providerId: 'p', model: 'm',
        },
      }],
    };
    useGraphStore.getState().setProject({
      ...project,
      nodes: { ...project.nodes, selected: mediaNode },
    });
    render(<NodeSidePanel />);

    expect(screen.getByRole('button', { name: 'Regenerate image' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Reload media' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit header' })).toBeEnabled();
  });

  it('greys out generated-image regeneration when Image model is None', () => {
    useSettingsStore.setState({ imageModelRef: null });
    seed();
    const project = useGraphStore.getState().project!;
    const selected = project.nodes.selected!;
    useGraphStore.getState().setProject({
      ...project,
      nodes: {
        ...project.nodes,
        selected: {
          ...selected,
          type: 'media',
          versions: [{
            header: 'Image: memory', body: '', createdAt: 2, generatedBy: 'media', contentType: 'media',
            media: { source: 'asset', kind: 'image', assetId: 'generated' },
            imageGeneration: {
              prompt: 'memory', promptSource: 'media-prompt', providerId: 'image-provider', model: 'gpt-image-2',
            },
          }],
        },
      },
    });
    render(<NodeSidePanel />);
    expect(screen.getByRole('button', { name: 'Regenerate image' })).toBeDisabled();
  });

  it('orders action rows before an alphabetical, height-capped group list', () => {
    const { container } = renderPanel({ withChild: true });
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));
    expect(container.querySelector('.side-disclosure-content--group')).toBeTruthy();
    const menu = container.querySelector('.group-popover')!;
    const actions = within(menu as HTMLElement).getAllByRole('button');
    expect(actions[0]).toHaveAccessibleName('Add to new group');
    expect(actions[1]).toHaveAccessibleName('Add branch to new group');
    expect(actions[2]).toHaveAccessibleName('Remove from group');
    expect(actions[3]).toHaveAccessibleName('Remove branch from groups');

    const list = container.querySelector('[data-group-list]')!;
    expect(list).toHaveStyle({ maxHeight: '120px' });
    const groupNames = within(list as HTMLElement)
      .getAllByRole('button', { name: /^Add node to / })
      .map((button) => button.getAttribute('aria-label'));
    expect(groupNames).toEqual([
      'Add node to Alpha studies',
      'Add node to Historical theories of memory consolidation and reconsolidation across different research periods',
      'Add node to zoology',
    ]);
  });

  it('describes group-wide actions as branch actions in tooltips', () => {
    renderPanel({ withChild: true, groupedNode: true });
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));

    expect(screen.getByRole('button', { name: 'Add branch to new group' })).toHaveAttribute(
      'data-tip',
      'Create a new group for this node and its branch',
    );
    expect(screen.getByRole('button', { name: 'Remove branch from groups' })).toHaveAttribute(
      'data-tip',
      'Remove this node and every grouped descendant in its branch from their groups',
    );
    expect(screen.getByRole('button', { name: 'Add branch to zoology' })).toHaveAttribute(
      'data-tip',
      "Add this node's branch to zoology",
    );
  });

  it('does not offer the removed Sources panel', () => {
    renderPanel({ withSources: true });
    expect(screen.getByRole('button', { name: 'Add node' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show sources' })).toBeNull();
  });

  it('uses a disclosure for Wikimedia images and keeps redo search underneath it', () => {
    renderPanel({ withWikimedia: true });
    const trigger = screen.getByRole('button', { name: /Show free images/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger.querySelector('.lucide-chevron-right')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Redo agentic search' })).toBeNull();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.querySelector('.lucide-chevron-down')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Redo agentic search' })).toBeTruthy();
    expect(useCitationPanelStore.getState()).toMatchObject({
      mode: 'wikimedia',
      nodeId: 'selected',
      wikimediaVersionCreatedAt: 0,
    });
  });

  it('keeps manual browsing available but waits for vision metadata before enabling AI redo', () => {
    useModelCatalogStore.getState().clear();
    renderPanel({ withWikimedia: true });

    const trigger = screen.getByRole('button', { name: /Show free images/ });
    expect(trigger).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(trigger);

    const redo = screen.getByRole('button', { name: 'Redo agentic search' });
    expect(redo).toHaveAttribute('aria-disabled', 'true');
    expect(useCitationPanelStore.getState()).toMatchObject({
      mode: 'wikimedia',
      nodeId: 'selected',
    });

    act(() => {
      useModelCatalogStore.getState().setCatalog('image-provider', [{
        id: 'text-model', caps: { vision: true, textOutput: true },
      }]);
    });

    expect(redo).toHaveAttribute('aria-disabled', 'false');
  });

  it('redoes the AI search even when the saved results came from a manual query', () => {
    seed();
    const node = useGraphStore.getState().project!.nodes.selected!;
    useGraphStore.getState().updateNode(node.id, { versions: [{ ...node.versions[0]!, imageRecommendations: {
      schemaVersion: 2, bodyFingerprint: 'body', searchedAt: 1, mode: 'manual', manualQuery: 'A manual query',
      resultLimit: 40, sourceOutcomes: [], results: [],
    } }] });
    const search = vi.spyOn(imageDiscovery, 'startWikimediaDiscovery').mockResolvedValue();
    render(<NodeSidePanel />);
    fireEvent.click(screen.getByRole('button', { name: /Show free images/ }));
    const redo = screen.getByRole('button', { name: 'Redo agentic search' });
    expect(redo).toHaveAttribute('data-tip', 'Redo the AI-assisted image search for this node');
    fireEvent.click(redo);
    expect(search).toHaveBeenCalledExactlyOnceWith('selected', 0, { rerun: true });
  });

  it('keeps removal visible and enables only the meaningful regions', () => {
    renderPanel({ withChild: true, groupedChild: true });
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));
    expect(screen.getByRole('button', { name: 'Remove from group' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove branch from groups' })).toBeEnabled();
  });

  it('keeps a right-hand branch action on every row for a leaf node', () => {
    renderPanel({ groupedNode: true });
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));
    expect(screen.getByRole('button', { name: 'Add branch to new group' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove branch from groups' })).toBeEnabled();
    expect(screen.getAllByRole('button', { name: /^Add branch to / })).toHaveLength(
      Object.keys(groups).length + 1,
    );
  });

  it('tints the whole existing-group row and marks the current group', () => {
    const { container } = renderPanel({ groupedNode: true });
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));
    const row = screen.getByRole('button', { name: 'Add node to zoology' }).closest('[data-group-row]');
    expect(row).toHaveClass('has-accent', 'active');
    expect(row).toHaveStyle({ '--row-accent': '#78a66b' });
    expect(container.querySelector('.group-popover .dot')).toBeNull();
    expect(within(row as HTMLElement).getByText('✓')).toBeTruthy();
  });

  it('puts the node current group before the alphabetized alternatives', () => {
    renderPanel({ groupedNode: true });
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));
    const rows = screen.getAllByRole('button', { name: /^Add node to / });
    expect(rows[0]).toHaveAccessibleName('Add node to zoology');
  });

  it('shows the first two lines at rest and loops only the exact overflowing row on hover', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.hasAttribute('data-group-name-measure')) return 0;
      if (this.textContent === 'Alpha studies') return 18;
      if (this.textContent === 'zoology') return 36;
      return 72;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-group-name-static') ? 36 : 0;
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));

    const longButton = screen.getByRole('button', {
      name: 'Add node to Historical theories of memory consolidation and reconsolidation across different research periods',
    });
    const longRow = longButton.closest('[data-group-row]') as HTMLElement;
    const alphaRow = screen.getByRole('button', { name: 'Add node to Alpha studies' })
      .closest('[data-group-row]') as HTMLElement;
    const zoologyRow = screen.getByRole('button', { name: 'Add node to zoology' })
      .closest('[data-group-row]') as HTMLElement;
    expect(within(alphaRow).getByTestId('group-name-display')).toHaveAttribute(
      'data-group-visible-lines',
      '1',
    );
    expect(within(zoologyRow).getByTestId('group-name-display')).toHaveAttribute(
      'data-group-visible-lines',
      '2',
    );
    expect(within(longRow).getByTestId('group-name-display')).toHaveAttribute(
      'data-group-visible-lines',
      '2',
    );
    expect(within(longRow).getByTestId('group-name-static')).toBeVisible();
    expect(within(longRow).queryByTestId('group-name-loop')).toBeNull();

    fireEvent.mouseEnter(longRow);
    expect(within(longRow).getByTestId('group-name-loop')).toBeVisible();
    expect(within(alphaRow).queryByTestId('group-name-loop')).toBeNull();

    fireEvent.mouseLeave(longRow);
    expect(within(longRow).getByTestId('group-name-static')).toBeVisible();
    expect(within(longRow).queryByTestId('group-name-loop')).toBeNull();
  });
});
