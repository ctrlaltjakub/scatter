import type { Project, ProjectSource, ProjectSourceLibrary } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { loadProjectById, metaOf, saveProjectFile } from '@/opfs/projectsIO';
import { EMPTY_SOURCE_LIBRARY, publishReadySource, removeReadySource, reorderSourceIds } from './projectSources';

async function updateInactiveProjectMeta(project: Project): Promise<void> {
  const state = useGraphStore.getState();
  const list = state.projectList.map((meta) => meta.id === project.id ? metaOf(project) : meta);
  state.setProjectList(list);
}

/** Source publication/deletion is storage lifecycle, not an undoable edit. */
export async function mutateSourceLibraryWithoutHistory(
  projectId: string,
  update: (library: ProjectSourceLibrary) => ProjectSourceLibrary,
): Promise<Project | null> {
  const graph = useGraphStore.getState();
  if (graph.project?.id === projectId) {
    const temporal = useGraphStore.temporal.getState();
    temporal.pause();
    try {
      useGraphStore.setState((state) => {
        if (state.project?.id !== projectId) return state;
        const sourceLibrary = update(state.project.sourceLibrary ?? EMPTY_SOURCE_LIBRARY);
        if (sourceLibrary === state.project.sourceLibrary) return state;
        return { project: { ...state.project, sourceLibrary, updatedAt: Date.now() } };
      });
    } finally {
      temporal.resume();
    }
    return useGraphStore.getState().project;
  }
  const project = await loadProjectById(projectId);
  if (!project) return null;
  const sourceLibrary = update(project.sourceLibrary ?? EMPTY_SOURCE_LIBRARY);
  const next = { ...project, sourceLibrary, updatedAt: Date.now() };
  await saveProjectFile(next);
  await updateInactiveProjectMeta(next);
  return next;
}

export async function publishProjectSource(projectId: string, source: ProjectSource): Promise<Project | null> {
  return mutateSourceLibraryWithoutHistory(projectId, (library) => publishReadySource(library, source));
}

export async function removeProjectSource(projectId: string, sourceId: string): Promise<Project | null> {
  return mutateSourceLibraryWithoutHistory(projectId, (library) => removeReadySource(library, sourceId));
}

/** List organization is presentation state, matching project/group ordering:
 * persist it, but keep it out of content undo/redo. */
export async function reorderProjectSourcesWithoutHistory(
  projectId: string,
  sourceId: string,
  beforeSourceId: string,
): Promise<Project | null> {
  return mutateSourceLibraryWithoutHistory(projectId, (library) => (
    reorderSourceIds(library, sourceId, beforeSourceId)
  ));
}

export async function readProjectForSources(projectId: string): Promise<Project | null> {
  const active = useGraphStore.getState().project;
  return active?.id === projectId ? active : loadProjectById(projectId);
}
