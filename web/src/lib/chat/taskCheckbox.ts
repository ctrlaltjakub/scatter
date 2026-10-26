import { useGraphStore } from '@/store/useGraphStore';

/** A checkbox is a small, undoable content edit, not a focus/navigation action. */
export function toggleTaskCheckbox(nodeId: string, createdAt: number, offset: number): void {
  const graph = useGraphStore.getState();
  const node = graph.project?.nodes[nodeId];
  if (!node || node.generating) return;
  const index = node.versions.findIndex(v => v.createdAt === createdAt);
  const version = node.versions[index];
  if (!version || !Number.isInteger(offset) || version.body[offset - 1] !== '[' || version.body[offset + 1] !== ']' || !/[ xX]/.test(version.body[offset] ?? '')) return;
  const versions = [...node.versions];
  versions[index] = { ...version, body: version.body.slice(0, offset) + (version.body[offset] === ' ' ? 'x' : ' ') + version.body.slice(offset + 1), answerEnrichmentId: undefined };
  graph.updateNode(nodeId, { versions });
}
