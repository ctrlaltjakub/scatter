import type { ChatMdNode } from './markdownFields';

/** GFM only recognizes task markers followed by content. The visual editor
 * also produces empty tasks, so recognize those in both renderers and retain
 * the original checkbox offset for small, undoable canvas edits. */
export function normalizeMarkdownTasks(root: ChatMdNode, source: string): void {
  const visit = (item: ChatMdNode) => {
    if (item.type === 'listItem') {
      const start = item.position?.start.offset;
      const match = start == null ? null : source.slice(start).match(/^(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\](?=[ \t\r\n]|$)/);
      if (match && start != null) {
        const paragraph = item.children?.[0];
        const text = paragraph?.children?.[0];
        if (item.checked == null && paragraph?.type === 'paragraph' && paragraph.children?.length === 1
          && text?.type === 'text' && text.value?.trim() === `[${match[1]}]`) {
          item.checked = match[1] !== ' ';
          paragraph.children = [];
        }
        if (item.checked != null) item.data = { ...item.data, hProperties: { ...item.data?.hProperties,
          'data-task-offset': start + match[0].lastIndexOf('[') + 1,
        } };
      }
    }
    item.children?.forEach(visit);
  };
  visit(root);
}
