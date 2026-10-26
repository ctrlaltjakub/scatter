import { cancelNodeGeneration } from '@/lib/generate';
import { useGraphStore } from '@/store/useGraphStore';
import { nextUndoDescriptor } from '@/store/useHistoryMetaStore';
import { saveProjectsIndex } from '@/opfs/projectsIO';

/**
 * Abort only generation sessions owned by the action being undone. The
 * provisional content remains in zundo's redo snapshot, but its network work
 * stops before the node/version disappears. Redo therefore never spends API
 * credit or silently restarts a request.
 */
function stopAffectedGeneration(): void {
  const descriptor = nextUndoDescriptor();
  if (!descriptor) return;
  const project = useGraphStore.getState().project;
  if (!project) return;
  for (const nodeId of descriptor.nodeIds) {
    if (project.nodes[nodeId]?.generating) {
      cancelNodeGeneration(nodeId);
    }
  }
}

export function undoGraphHistory(): void {
  stopAffectedGeneration();
  useGraphStore.temporal.getState().undo();
  persistRegistryMirror();
}

export function redoGraphHistory(): void {
  useGraphStore.temporal.getState().redo();
  persistRegistryMirror();
}

function persistRegistryMirror(): void {
  const state = useGraphStore.getState();
  void saveProjectsIndex({
    activeId: state.activeProjectId,
    items: state.projectList,
  }).catch((error) => {
    console.error('[scatter] could not persist project metadata after undo/redo', error);
  });
}
