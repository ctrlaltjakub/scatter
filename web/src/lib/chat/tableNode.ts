import type { ChatAnswerRef } from '@/store/chatTypes';
import type { NodeVersion, ScatterNode } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { useChatTableStore } from '@/store/useChatTableStore';
import { parseChatMarkdown, type ChatMdNode } from './markdownFields';
import { answerVersion } from './model';
import { newId } from '../ids';
import { spawnNearParent } from '../generate';
import { versionLanguage } from '../languages';
import { termPreviewFingerprint } from '../termPreviewCore';
import { APPROX_HEADER_CHROME } from '../nodeSize';

export const TABLE_NODE_MAX_WIDTH = 1200;
export const TABLE_NODE_MAX_BODY_HEIGHT = 810;

/** Keep source Markdown (including escaped pipes, terms and math), not DOM text.
 * Rebuild row boundaries so tables nested in a quote/list also stand alone. */
export function tableMarkdown(body: string, index: number): string | null {
  const root = parseChatMarkdown(body);
  type TableNode = ChatMdNode & { align?: (string | null)[]; identifier?: string };
  const tables: TableNode[] = [], definitions: TableNode[] = [];
  const walk = (node: TableNode) => {
    if (node.type === 'table') tables.push(node);
    else if (node.type === 'definition' || node.type === 'footnoteDefinition') definitions.push(node);
    else node.children?.forEach(walk);
  };
  walk(root);
  const table = tables[index];
  if (!table?.children?.length) return null;
  const raw = (node: ChatMdNode) => body.slice(node.position?.start.offset, node.position?.end.offset).trim();
  const cellSource = (cell: ChatMdNode) => {
    const first = cell.children?.[0], last = cell.children?.at(-1);
    return first && last ? body.slice(first.position?.start.offset, last.position?.end.offset).trim() : '';
  };
  const rows = table.children.map(row => `| ${(row.children ?? []).map(cellSource).join(' | ')} |`);
  rows.splice(1, 0, `| ${(table.children[0]?.children ?? []).map((_, i) => {
    const align = table.align?.[i]; return align === 'left' ? ':---' : align === 'right' ? '---:' : align === 'center' ? ':---:' : '---';
  }).join(' | ')} |`);
  const referenced = new Set<string>();
  const collectReferences = (node: TableNode) => {
    if (node.identifier) referenced.add(node.identifier);
    node.children?.forEach(collectReferences);
  };
  collectReferences(table);
  const used = definitions.filter(definition => definition.identifier && referenced.has(definition.identifier));
  return [rows.join('\n'), ...used.map(raw)].join('\n\n');
}

/** Measure an untransformed copy in the same reading font. The cap limits only
 * the initial card: large tables remain scrollable and users can resize it. */
export function measureTableNode(table: HTMLTableElement): { width: number; bodyMaxHeight: number } {
  const lab = document.createElement('div');
  lab.className = 'node chat-node';
  lab.setAttribute('aria-hidden', 'true'); lab.setAttribute('data-sc-capture-exclude', '');
  lab.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;contain:layout style;transform:none;width:max-content;height:auto';
  const markdown = document.createElement('div'); markdown.className = 'chat-markdown';
  const source = table.closest('.chat-markdown') ?? table;
  const typography = getComputedStyle(source);
  for (const property of ['font-family', 'font-size', 'font-size-adjust', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'direction']) {
    markdown.style.setProperty(property, typography.getPropertyValue(property));
  }
  const piece = table.closest('.chat-table-piece')!.cloneNode(true) as HTMLElement;
  piece.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
  const copy = piece.querySelector('table')!;
  copy.style.minWidth = '0';
  // Fullscreen tables omit their own fullscreen button. Reserve equivalent
  // action space when measuring a copy made from that viewer.
  const actions = piece.querySelector('.chat-table-actions');
  if (actions && actions.children.length < 3) {
    const button = document.createElement('button'); button.className = 'chat-table-expand';
    button.textContent = '↗ View table fullscreen'; actions.prepend(button);
  }
  markdown.appendChild(piece); lab.appendChild(markdown); document.body.appendChild(lab);
  try {
    const width = Math.min(TABLE_NODE_MAX_WIDTH, Math.max(400, Math.ceil(copy.scrollWidth) + 44));
    markdown.style.width = `${width - 44}px`;
    copy.style.minWidth = '100%';
    const bodyMaxHeight = Math.min(TABLE_NODE_MAX_BODY_HEIGHT, Math.max(120, Math.ceil(piece.offsetHeight) + 72));
    return { width, bodyMaxHeight };
  } finally { lab.remove(); }
}

/** A table copy is one undoable structural edit; it makes no model requests. */
export function copyTableToNode(nodeId: string, ref: ChatAnswerRef, tableIndex: number, size: { width: number; bodyMaxHeight: number }): string | null {
  const graph = useGraphStore.getState(), project = graph.project;
  const parent = project?.nodes[nodeId], source = parent && answerVersion(parent, ref);
  const body = source && tableMarkdown(source.body, tableIndex);
  if (!project || !parent || !source || !body) return null;
  const id = newId();
  const version: NodeVersion = {
    header: 'Table', body, createdAt: Date.now(), generatedBy: 'manual', contentType: 'answer', markdownNote: true,
    language: versionLanguage(source), width: size.width, minWidth: 320, bodyMaxHeight: size.bodyMaxHeight, minBodyHeight: 120,
    sources: structuredClone(source.sources), internalSources: structuredClone(source.internalSources),
    chat: { turnId: id, title: 'Table', question: '', state: 'complete', informationChunking: false, contextPath: [] },
  };
  if (source.termPreviews?.fingerprint === termPreviewFingerprint(source)) {
    version.termPreviews = { fingerprint: termPreviewFingerprint(version), entries: structuredClone(source.termPreviews.entries) };
  }
  const node: ScatterNode = { id, type: 'manual-empty', groupId: parent.groupId, frozen: false, currentVersionIndex: 0, versions: [version],
    position: spawnNearParent(parent, Object.values(project.nodes), size.width, size.bodyMaxHeight + APPROX_HEADER_CHROME) };
  graph.addNodeWithArrow(node, { id: newId(), fromNodeId: nodeId, toNodeId: id, kind: 'auto', sourceAnswer: { ...ref }, label: 'Table' });
  graph.setSelection([id]); graph.requestPanTo(id, nodeId, 'newNodes');
  useChatTableStore.getState().close();
  return id;
}
