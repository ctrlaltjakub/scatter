import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS, type Group, type ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { SidebarGroupRow } from './Sidebar';

const group: Group = {
  id: 'group-long',
  name: 'Historical theories of memory consolidation across several research periods',
  color: '#8d74bf',
  gravitate: false,
};

const root: ScatterNode = {
  id: 'root',
  type: 'root',
  position: { x: 0, y: 0 },
  frozen: false,
  versions: [{ header: 'Root', body: 'Root.', createdAt: 0, generatedBy: 'root' }],
  currentVersionIndex: 0,
};

describe('Sidebar group row names', () => {
  beforeEach(() => {
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const project = createBlankProject('sidebar-groups', root.id);
    useGraphStore.getState().setProject({
      ...project,
      color: '#78a66b',
      nodes: { [root.id]: root },
      groups: { [group.id]: group },
    });
    useGraphStore.setState({ lastInteractedGroupIds: {}, selectedGroupId: null, panTo: null });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
    useGraphStore.getState().setProject(null);
    vi.restoreAllMocks();
  });

  it('keeps the original compact single-line group-name presentation', () => {
    const { container } = render(<SidebarGroupRow group={group} />);
    const row = container.querySelector('.sidebar-row') as HTMLElement;
    const name = row.querySelector('.row-name');

    expect(row).not.toHaveClass('sidebar-group-row');
    expect(name).toHaveTextContent(group.name);
    expect(row.querySelector('[data-testid="group-name-display"]')).toBeNull();
    expect(row.querySelector('[data-testid="group-name-loop"]')).toBeNull();
  });

  it('keeps a repeatedly clicked group selected and requests a fit for all members', () => {
    const memberA = { ...root, id: 'a', groupId: group.id };
    const memberB = { ...root, id: 'b', groupId: group.id };
    useGraphStore.setState((state) => ({
      project: state.project
        ? { ...state.project, nodes: { root, a: memberA, b: memberB } }
        : null,
      panTo: null,
      selectedGroupId: null,
    }));
    const { container } = render(<SidebarGroupRow group={group} />);
    const row = container.querySelector('.sidebar-row') as HTMLElement;

    fireEvent.click(row);
    const firstRequest = useGraphStore.getState().panTo;
    expect(useGraphStore.getState().selectedGroupId).toBe(group.id);
    expect(useGraphStore.getState().project?.selection).toEqual(['a', 'b']);
    expect(firstRequest).toMatchObject({ kind: 'nodes', ids: ['a', 'b'], automatic: 'groups' });

    fireEvent.click(row);
    expect(useGraphStore.getState().selectedGroupId).toBe(group.id);
    expect(useGraphStore.getState().panTo!.requestId).toBeGreaterThan(firstRequest!.requestId);
  });

  it('selects the same group members without moving the camera when group framing is off', () => {
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, groups: false } });
    const project = useGraphStore.getState().project!;
    useGraphStore.setState({ project: { ...project, nodes: {
      root, a: { ...root, id: 'a', groupId: group.id }, b: { ...root, id: 'b', groupId: group.id },
    } } });
    useGraphStore.temporal.getState().clear();
    const { container } = render(<SidebarGroupRow group={group} />);
    const row = container.querySelector('.sidebar-row')!;
    fireEvent.click(row);
    fireEvent.click(row);
    expect(useGraphStore.getState().selectedGroupId).toBe(group.id);
    expect(useGraphStore.getState().project?.selection).toEqual(['a', 'b']);
    expect(useGraphStore.getState().panTo).toBeNull();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('treats opening the group editor as interaction even when nothing changes', () => {
    const project = useGraphStore.getState().project!;
    useGraphStore.setState({
      project: {
        ...project,
        groups: {
          ...project.groups,
          other: { id: 'other', name: 'Other', color: '#123456', gravitate: false },
        },
      },
      lastInteractedGroupIds: { [project.id]: 'other' },
    });
    render(<SidebarGroupRow group={group} />);

    fireEvent.click(screen.getByRole('button', { name: `Edit ${group.name}` }));

    expect(useGraphStore.getState().lastInteractedGroupIds[project.id]).toBe(group.id);
  });

  it('deletes a group with one trash-button click', () => {
    render(<SidebarGroupRow group={group} />);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${group.name}` }));

    expect(useGraphStore.getState().project?.groups[group.id]).toBeUndefined();
  });
});
