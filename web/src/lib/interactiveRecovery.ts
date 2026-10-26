import type { ScatterNode } from '@/store/types';

/** Disk copies must never promise an AI request that no longer exists. Keep
 * partial code and the actual transcript so interrupted work remains recoverable. */
export function recoverInteractiveNode(node: ScatterNode): ScatterNode {
  if (!node.versions.some(v => v.interactiveBuild?.state === 'building')) return node;
  return { ...node, generating: false, generatingVersionIndex: undefined, versions: node.versions.map(v => v.interactiveBuild?.state === 'building' ? {
    ...v, interactiveBuild: { ...v.interactiveBuild, state: 'stopped', steps: v.interactiveBuild.steps.map(step =>
      step.state === 'running' ? { ...step, kind: undefined, state: 'failed', detail: 'Build interrupted' } : step) },
  } : v) };
}
