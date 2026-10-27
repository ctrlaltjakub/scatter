import type { ScatterNode } from '@/store/types';

/** Remove an exact displayed identity, preserving ownership of a different
 * version being generated. Deletion is content intent and remains undoable. */
export function removeNodeVersion(node: ScatterNode, createdAt: number): Partial<ScatterNode> | null {
  const index = node.versions.findIndex(version => version.createdAt === createdAt);
  if (index < 0 || node.versions.length <= 1) return null;
  const generating = node.generatingVersionIndex == null ? undefined : node.versions[node.generatingVersionIndex];
  const versions = node.versions.filter((_, candidate) => candidate !== index);
  return { versions, currentVersionIndex: Math.max(0, Math.min(versions.length - 1, index - 1)),
    ...(generating?.createdAt === createdAt ? { generating: false, generatingVersionIndex: undefined, streamingText: false }
      : generating ? { generatingVersionIndex: versions.findIndex(version => version.createdAt === generating.createdAt) } : {}) };
}
