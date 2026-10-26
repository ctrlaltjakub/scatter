import type { NodeVersion, Project, ScatterNode } from '@/store/types';
import { DEFAULT_NODE_W, INTERACTIVE_NODE_W, nodeWidth } from './nodeSize';
import { stripExplainHeaderSuffix } from './nodeContentType';

/** Storage migration only. The former prose + program renderer no longer
 * exists. Preserve prose/links in place and extract all saved program versions
 * into one dedicated child. Deterministic IDs make reloading and syncing safe. */
export function migrateInteractiveNodes(project: Project): Project {
  let nodes = project.nodes;
  let arrows = project.arrows;
  for (const node of Object.values(project.nodes)) {
    const legacy = node.versions.filter(v => !v.interactiveStandalone
      && (v.contentType === 'interactive' || !!v.interactive || (!v.contentType && node.type === 'interactive')));
    if (!legacy.length) continue;
    if (nodes === project.nodes) { nodes = { ...nodes }; arrows = { ...arrows }; }
    const legacySet = new Set(legacy);
    const { interactiveCollapsed: _collapsed, ...original } = node as ScatterNode & { interactiveCollapsed?: boolean };
    const versions = node.versions.map(v => {
      if (!legacySet.has(v)) return v;
      const { interactive: _program, interactiveProseWidth, interactiveStandalone: _marker,
        interactiveBuild: _build, ...text } = v as NodeVersion & { interactiveProseWidth?: number };
      return { ...text, contentType: 'explain' as const,
        generatedBy: text.generatedBy === 'interactive' ? 'explain' as const : text.generatedBy,
        width: interactiveProseWidth ?? DEFAULT_NODE_W };
    });
    nodes[node.id] = { ...original, type: node.type === 'interactive' ? 'explain' : node.type,
      versions, generating: false, generatingVersionIndex: undefined, generationError: undefined };

    let childId = `${node.id}-interactive`;
    let suffix = 1;
    while (nodes[childId] && nodes[childId]?.legacyInteractiveSourceId !== node.id) childId = `${node.id}-interactive-${suffix++}`;
    const existing = nodes[childId];
    const recovered: NodeVersion[] = legacy.map(v => {
      const request = v.interactive?.request || stripExplainHeaderSuffix(v.header);
      const error = v.interactive?.error || (!v.interactive?.html ? 'This older node has no saved program. Select Regenerate to create it.' : undefined);
      // Keep the original viewport, including old square programs. Rendering
      // scales it into the new frame; migration never rewrites generated code.
      const { autoRepairAttempted: _attempted, ...program } = (v.interactive as (NodeVersion['interactive'] & { autoRepairAttempted?: boolean })) ?? { html: '', request, model: '', providerId: '' };
      return { header: stripExplainHeaderSuffix(v.header), headerParts: { subject: stripExplainHeaderSuffix(v.header) },
        body: request, createdAt: v.createdAt, generatedBy: 'interactive', contentType: 'interactive',
        interactiveStandalone: true, width: INTERACTIVE_NODE_W,
        interactive: { ...program, error },
        interactiveBuild: { request, state: error ? 'failed' : 'complete', steps: [], error } };
    });
    // A stale cloud snapshot can contain the pre-migration parent beside an
    // already migrated child. Merge missing versions without overwriting edits.
    const known = new Set(existing?.versions.map(v => v.createdAt) ?? []);
    const programVersions = [...(existing?.versions ?? []), ...recovered.filter(v => !known.has(v.createdAt))];
    const currentLegacy = node.versions[node.currentVersionIndex];
    const shown = programVersions.findIndex(v => v.createdAt === currentLegacy?.createdAt);
    const position = existing?.position ?? placeChild(nodes[node.id]!, nodes);
    nodes[childId] = existing ? { ...existing, versions: programVersions } : {
      id: childId, type: 'interactive', frozen: node.frozen, groupId: node.groupId,
      legacyInteractiveSourceId: node.id, position, versions: programVersions,
      currentVersionIndex: shown >= 0 ? shown : programVersions.length - 1,
    };
    if (!Object.values(arrows).some(a => a.fromNodeId === node.id && a.toNodeId === childId)) {
      let arrowId = `${childId}-link`;
      while (arrows[arrowId]) arrowId += '-1';
      arrows[arrowId] = { id: arrowId, fromNodeId: node.id, toNodeId: childId, kind: 'auto' };
    }
  }
  return nodes === project.nodes ? project : { ...project, nodes, arrows };
}

function placeChild(parent: ScatterNode, nodes: Project['nodes']): ScatterNode['position'] {
  const x = parent.position.x + nodeWidth(parent) + 96;
  // Finite, deterministic placement: move below any intersecting existing card.
  let y = parent.position.y;
  const blockers = Object.values(nodes).filter(n => n.id !== parent.id
    && n.position.x < x + INTERACTIVE_NODE_W + 48 && n.position.x + nodeWidth(n) + 48 > x)
    .sort((a, b) => a.position.y - b.position.y);
  for (const n of blockers) {
    const bottom = n.position.y + (n.renderedHeight ?? 720) + 48;
    if (n.position.y < y + 720 && bottom > y) y = bottom;
  }
  return { x, y };
}
