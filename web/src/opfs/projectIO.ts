import type { Group, Project, ScatterNode } from '@/store/types';
import { readJSON, writeJSON, deleteFile } from './storage';
import { recoverChatNode } from '@/lib/chat/model';
import { recoverGroupTitle } from '@/lib/groupTitle';
import { recoverInteractiveNode } from '@/lib/interactiveRecovery';

const PATH = 'project.json';

/** Drop transient per-node fields before persisting. Otherwise an interrupted
 *  stream (HMR, dev-server bounce, tab close, refresh) saves `generating: true`
 *  to OPFS, and the cursor blinker is then stuck on the node forever because
 *  no stream is running on the next load to clear it. Exported so the
 *  multi-scatter writer (projectsIO.ts) strips the same fields. */
export function stripTransient(project: Project): Project {
  let nodes: Record<string, ScatterNode> | null = null;
  for (const [id, n] of Object.entries(project.nodes)) {
    const recovered = recoverInteractiveNode(recoverChatNode(n));
    if (recovered === n && !('generating' in n) && !('generatingVersionIndex' in n) && !('streamingText' in n) && !('generationError' in n)) continue;
    if (!nodes) nodes = { ...project.nodes };
    const clean = { ...recovered };
    delete clean.generating;
    delete clean.generatingVersionIndex;
    delete clean.streamingText;
    delete clean.generationError;
    nodes[id] = clean;
  }
  let groups: Record<string, Group> | null = null;
  for (const [id, group] of Object.entries(project.groups)) {
    const clean = recoverGroupTitle(group);
    if (clean === group) continue;
    if (!groups) groups = { ...project.groups };
    groups[id] = clean;
  }
  return nodes || groups ? { ...project, nodes: nodes ?? project.nodes, groups: groups ?? project.groups } : project;
}

export async function loadProject(): Promise<Project | null> {
  const p = await readJSON<Project>(PATH);
  return p ? stripTransient(p) : null;
}

export async function saveProject(project: Project): Promise<void> {
  await writeJSON(PATH, stripTransient(project));
}

/** Remove the legacy single-project file after it has been migrated into the
 *  per-scatter `projects/<id>.json` layout. */
export async function deleteLegacyProjectFile(): Promise<void> {
  await deleteFile(PATH);
}
