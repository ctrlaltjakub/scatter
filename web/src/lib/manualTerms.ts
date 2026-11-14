import { useGraphStore } from '@/store/useGraphStore';
import { useNodeStatusStore, type StatusEntry } from '@/store/useNodeStatusStore';
import type { NodeTextSelection } from '@/store/useNodeTextSelectionStore';
import type { NodeVersion, ScatterNode } from '@/store/types';
import { answerMarkingFingerprint, pendingAnswerTermMarking, shareAnswerEnrichment } from './chat/sharedEnrichment';
import { markSelectedTerm } from './termMarking';
import { termPreviewFingerprint, termPreviewKey } from './termPreviewCore';
import { generateTermPreviews, registerManualTermMark } from './termPreviews';

const marking = (status: StatusEntry | undefined) => status?.clearedAt == null
  && /MARKING (?:TERMS|CHIPS)/.test(status?.text ?? '');

export function termMarkingBusy(node: ScatterNode | undefined, version: NodeVersion | undefined,
  status: StatusEntry | undefined, processes: Record<string, StatusEntry> | undefined): boolean {
  return !node || !version || !!node.generating || version.chat?.state === 'generating'
    || version.answerTermMarking?.state === 'pending'
    || !!(version.answerEnrichmentId && pendingAnswerTermMarking.has(version.answerEnrichmentId))
    || marking(status) || Object.values(processes ?? {}).some(marking);
}

/** One undoable content edit. Explanations are derived background work and do
 * not add undo entries, block later selections, or replace other preview jobs. */
export function markTermFromSelection(projectId: string, selection: NodeTextSelection): boolean {
  const graph = useGraphStore.getState();
  if (graph.project?.id !== projectId) return false;
  const node = graph.project.nodes[selection.nodeId];
  const source = node?.versions[selection.versionIndex];
  const statuses = useNodeStatusStore.getState();
  if (!source || source.body !== selection.sourceBody
    || termMarkingBusy(node, source, statuses.statuses[selection.nodeId], statuses.processes[selection.nodeId])) return false;
  const marked = markSelectedTerm(selection);
  if (!marked) return false;
  let next: NodeVersion = { ...source, body: marked.body };
  if (node.chat && !source.answerEnrichmentId) next = shareAnswerEnrichment(next, `${projectId}:${node.id}:${source.createdAt}`);
  const cache = source.termPreviews?.fingerprint === termPreviewFingerprint(source) ? source.termPreviews : undefined;
  next.termPreviews = { ...cache, fingerprint: termPreviewFingerprint(next), entries: cache?.entries ?? {},
    manualTerms: [...new Set([...(cache?.manualTerms ?? []), termPreviewKey(marked.term)])] };
  if (next.chat) next.answerTermMarking = { fingerprint: answerMarkingFingerprint(next), state: 'complete' };
  // Markers add four source characters. Keep existing relation anchors at the
  // same visible occurrence, including repeated passages in this version.
  const [from, to] = marked.range;
  let arrows = graph.project.arrows;
  for (const arrow of Object.values(arrows)) {
    const anchor = arrow.sourceSelection;
    if (arrow.fromNodeId !== node.id || anchor?.sourceVersionCreatedAt !== source.createdAt) continue;
    if (arrows === graph.project.arrows) arrows = { ...arrows };
    arrows[arrow.id] = { ...arrow, sourceSelection: { ...anchor, parts: anchor.parts.map(part => ({ ...part,
      start: part.start + (part.start >= from ? 2 : 0) + (part.start >= to ? 2 : 0),
      end: part.end + (part.end > from ? 2 : 0) + (part.end > to ? 2 : 0),
    })) } };
  }
  registerManualTermMark(projectId, node.id, source.createdAt, next.body);
  useGraphStore.setState({ project: { ...graph.project, updatedAt: Date.now(), arrows,
    nodes: { ...graph.project.nodes, [node.id]: { ...node,
      versions: node.versions.map((v, index) => index === selection.versionIndex ? next : v) } } } });
  void generateTermPreviews(node.id, source.createdAt, false, { terms: [marked.term] });
  return true;
}
