import type { Project } from '@/store/types';
import type { PhysicsClient } from '@/physics/physicsClient';
import type { SourcePort } from '@/physics/sourcePort';
import { useImageGeometryStore } from '@/store/useImageGeometryStore';
import { imageArrowContext, imageAtlasFrame, imageContextMatches, imageMediaKey } from './imageAtlas';

/** Local ports are sent only when image layout/identity changes, never on a
 * physics tick, camera motion, hover, focus, or title-dot animation. */
export function createImageArrowSourceSync(physics: PhysicsClient, isKnown: (id: string) => boolean = () => true) {
  const sent = new Map<string, SourcePort>();
  let previousNodes: Project['nodes'] | undefined;
  let previousArrows: Project['arrows'] | undefined;
  let previousGeometry: ReturnType<typeof useImageGeometryStore.getState>['byNode'] | undefined;
  const sync = (project: Project) => {
    const updates: { arrowId: string; sourcePort?: SourcePort }[] = [];
    const geometry = useImageGeometryStore.getState().byNode;
    if (project.nodes === previousNodes && project.arrows === previousArrows && geometry === previousGeometry) return;
    previousNodes = project.nodes; previousArrows = project.arrows; previousGeometry = geometry;
    for (const arrow of Object.values(project.arrows)) {
      if (!isKnown(arrow.id)) continue;
      const from = project.nodes[arrow.fromNodeId];
      let sourcePort: SourcePort | undefined;
      if (from?.versions[from.currentVersionIndex]?.media?.kind === 'image') {
        const context = imageArrowContext(arrow, project.nodes[arrow.toNodeId]);
        const measured = geometry[arrow.fromNodeId];
        if (context && measured?.projectId === project.id && imageContextMatches(context, from)
          && measured.mediaKey === imageMediaKey(context.sourceMedia)) {
          sourcePort = imageAtlasFrame(context, measured.rect)?.port;
        }
      }
      if (sourcePort === sent.get(arrow.id)) continue;
      if (sourcePort) sent.set(arrow.id, sourcePort); else sent.delete(arrow.id);
      updates.push({ arrowId: arrow.id, sourcePort });
    }
    for (const id of sent.keys()) if (!project.arrows[id]) sent.delete(id);
    if (updates.length) physics.setArrowSources(updates);
  };
  return { sync, forget: (id: string) => { sent.delete(id); previousArrows = undefined; } };
}
