/**
 * Export an EditorModel to clean, standard Markdown. Terms export as plain text
 * (Markdown has no "term" concept); bold survives as `**…**`. Used by the
 * "Edit text" editor's "Export .md".
 */
import type { EditorModel, Inline } from './editorSerialize';

function runsMd(runs: Inline[]): string {
  // Coalesce CONSECUTIVE bold runs into one `**…**` span. Otherwise a term inside
  // a bold phrase (two adjacent bold runs) would emit `**a****b**`, which renders
  // a literal `**` in Markdown viewers. (Terms themselves export as plain text.)
  let out = '';
  let i = 0;
  while (i < runs.length) {
    if (runs[i]!.bold) {
      let text = '';
      while (i < runs.length && runs[i]!.bold) {
        text += runs[i]!.text;
        i++;
      }
      out += `**${text}**`;
    } else {
      out += runs[i]!.text;
      i++;
    }
  }
  return out;
}

export function modelToMarkdown(m: EditorModel): string {
  const out: string[] = [];
  if (m.title.trim()) out.push(`# ${m.title.trim()}`);

  for (const p of m.freeText) {
    const s = runsMd(p).trim();
    if (s) out.push(s);
  }

  for (const b of m.bullets) {
    const children = b.children.filter((c) => c.name.trim());
    if (!b.title.trim() && children.length === 0) continue;
    const lines = [`- ${b.title.trim()}`];
    for (const c of children) {
      const d = runsMd(c.desc).trim();
      lines.push(d ? `  - ${c.name.trim()}: ${d}` : `  - ${c.name.trim()}`);
    }
    out.push(lines.join('\n'));
  }

  return out.join('\n\n') + '\n';
}
