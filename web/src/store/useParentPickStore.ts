import { create } from 'zustand';
import { parentChoices } from '@/lib/changeParent';
import { useGraphStore } from './useGraphStore';

type Point = { x: number; y: number };
export interface ParentPick {
  projectId: string; nodeId: string; arrowId: string; fromNodeId: string;
  candidates: ReadonlySet<string>; startedAt: number; keyboard: boolean;
  /** Transient screen coordinates. Mutated by pointer input, sampled by just
   * the preview's animation frame. No per-pointer React or graph updates. */
  pointer: Point;
}
export const useParentPickStore = create<{ pick: ParentPick | null }>(() => ({ pick: null }));

export function beginParentPick(nodeId: string, pointer: Point, keyboard: boolean): void {
  const graph = useGraphStore.getState(), project = graph.project;
  if (!project || project.selection.length !== 1 || project.selection[0] !== nodeId) return;
  const { arrow, candidates } = parentChoices(project, nodeId);
  if (!arrow || !candidates.size) return;
  if (graph.panTo) graph.requestPanTo(null);
  useParentPickStore.setState({ pick: { projectId: project.id, nodeId, arrowId: arrow.id, fromNodeId: arrow.fromNodeId,
    candidates, startedAt: performance.now(), pointer: { ...pointer }, keyboard } });
}
export function cancelParentPick(): void {
  if (useParentPickStore.getState().pick) useParentPickStore.setState({ pick: null });
}
export function chooseParent(id: string): boolean {
  const pick = useParentPickStore.getState().pick;
  if (!pick) return false;
  if (id === pick.nodeId || id === pick.fromNodeId) { cancelParentPick(); return false; }
  if (!pick.candidates.has(id)) return false;
  const changed = useGraphStore.getState().changeParent(pick.projectId, pick.nodeId, id, { id: pick.arrowId, fromNodeId: pick.fromNodeId });
  cancelParentPick();
  return changed;
}

/** No subscription is installed outside of pick mode. */
export function watchParentPick(): () => void {
  return useGraphStore.subscribe((state, previous) => {
    const pick = useParentPickStore.getState().pick, project = state.project;
    if (!pick) return;
    if (!project || project.id !== pick.projectId || project.selection.length !== 1 || project.selection[0] !== pick.nodeId
      || !project.nodes[pick.nodeId] || state.projectLoadRevision !== previous.projectLoadRevision) { cancelParentPick(); return; }
    if (previous.project?.arrows === project.arrows && (previous.project.nodes === project.nodes
      || Object.keys(previous.project.nodes).length === Object.keys(project.nodes).length)) return;
    const { arrow, candidates } = parentChoices(project, pick.nodeId);
    if (!arrow || arrow.id !== pick.arrowId || arrow.fromNodeId !== pick.fromNodeId || !candidates.size) { cancelParentPick(); return; }
    useParentPickStore.setState({ pick: { ...pick, candidates } });
  });
}
