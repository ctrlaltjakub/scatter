import type { Group, Project, ScatterNode } from '@/store/types';
import { recoverGroupTitle } from '@/lib/groupTitle';
import { recoverInteractiveNode } from '@/lib/interactiveRecovery';
import type { NodeRecordPatch, ProjectFilePatch } from './projectPersistenceProtocol';

function stripTransientNode(node: ScatterNode): ScatterNode {
  node = recoverInteractiveNode(node);
  if (
    !('generating' in node)
    && !('generatingVersionIndex' in node)
    && !('streamingText' in node)
    && !('generationError' in node)
  ) return node;
  const clean = { ...node };
  delete clean.generating;
  delete clean.generatingVersionIndex;
  delete clean.streamingText;
  delete clean.generationError;
  return clean;
}

export function stripTransientProject(project: Project): Project {
  let nodes: Record<string, ScatterNode> | null = null;
  for (const [id, node] of Object.entries(project.nodes)) {
    const clean = stripTransientNode(node);
    if (clean === node) continue;
    if (!nodes) nodes = { ...project.nodes };
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

function applyRecordPatch<T>(
  current: Record<string, T>,
  patch: { upsert: Record<string, T>; remove: string[] },
): Record<string, T> {
  const upserts = Object.entries(patch.upsert);
  if (upserts.length === 0 && patch.remove.length === 0) return current;
  const next = { ...current };
  for (const id of patch.remove) delete next[id];
  for (const [id, value] of upserts) next[id] = value;
  return next;
}

function applyNodeRecordPatch(
  current: Record<string, ScatterNode>,
  patch: NodeRecordPatch,
): Record<string, ScatterNode> {
  let next = applyRecordPatch(current, patch);
  const updates = Object.entries(patch.update);
  if (updates.length === 0) return next;
  if (next === current) next = { ...next };
  for (const [id, update] of updates) {
    const currentNode = next[id];
    if (!currentNode) continue;
    const node = { ...currentNode } as ScatterNode & Record<string, unknown>;
    for (const key of update.remove) delete node[key];
    Object.assign(node, update.set);
    if (update.versions) {
      const versions = currentNode.versions.slice(0, update.versions.length);
      versions.length = update.versions.length;
      for (const [index, version] of Object.entries(update.versions.upsert)) {
        versions[Number(index)] = version;
      }
      for (const [index, versionPatch] of Object.entries(update.versions.update)) {
        const numericIndex = Number(index);
        const currentVersion = versions[numericIndex];
        if (!currentVersion) continue;
        const version = { ...currentVersion } as typeof currentVersion & Record<string, unknown>;
        for (const key of versionPatch.remove) delete version[key];
        Object.assign(version, versionPatch.set);
        versions[numericIndex] = version;
      }
      node.versions = versions;
    }
    next[id] = node;
  }
  return next;
}

export function applyProjectFilePatch(
  project: Project,
  patch: ProjectFilePatch,
): Project {
  const base = { ...project } as Project & Record<string, unknown>;
  for (const key of patch.base.remove) delete base[key];
  Object.assign(base, patch.base.set);

  let nodes = applyNodeRecordPatch(project.nodes, patch.nodes);
  let arrows = applyRecordPatch(project.arrows, patch.arrows);
  const groups = applyRecordPatch(project.groups, patch.groups);

  if (Object.keys(patch.runtime.positions).length > 0) {
    if (nodes === project.nodes) nodes = { ...nodes };
    for (const [id, position] of Object.entries(patch.runtime.positions)) {
      const node = nodes[id];
      if (node) nodes[id] = { ...node, position };
    }
  }
  if (Object.keys(patch.runtime.activeBulletIdx).length > 0) {
    if (nodes === project.nodes) nodes = { ...nodes };
    for (const [id, activeBulletIdx] of Object.entries(patch.runtime.activeBulletIdx)) {
      const node = nodes[id];
      if (!node) continue;
      if (activeBulletIdx === null) {
        if (node.activeBulletIdx === undefined) continue;
        const { activeBulletIdx: _drop, ...rest } = node;
        nodes[id] = rest as ScatterNode;
      } else {
        nodes[id] = { ...node, activeBulletIdx };
      }
    }
  }
  if (Object.keys(patch.runtime.anchors).length > 0) {
    if (arrows === project.arrows) arrows = { ...arrows };
    for (const [id, anchors] of Object.entries(patch.runtime.anchors)) {
      const arrow = arrows[id];
      if (arrow) arrows[id] = { ...arrow, anchors };
    }
  }

  return { ...base, nodes, arrows, groups };
}
