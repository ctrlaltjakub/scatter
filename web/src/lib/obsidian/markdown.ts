import type { NodeVersion, Project, ScatterNode } from '@/store/types';
import { answerVersion, conversationPath } from '../chat/model';
import { parseBody } from '../bulletParse';
import { stripChipMarkers, wholeTerm } from '../bulletTerms';
import { nodeRelations } from '../nodeRelations';
import { currentContentType } from '../nodeContentType';
import { exportSourceEntries } from '../exportSources';
import { replaceTermMarkers } from '../termMarking';
import { termPreviewFingerprint, termPreviewKey } from '../termPreviewCore';
import type { MediaRef } from '@/store/types';

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const label = (text: string) => oneLine(text).replace(/[\\[\]*_<>]/g, '\\$&');
export const localLink = (text: string, relative: string, embed = false) =>
  (embed ? '!' : '') + '[' + label(text) + '](<' + relative.split('/').map(encodeURIComponent).join('/') + '>)';
export function webLink(url?: string) {
  if (!url) return;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href.replace(/[<>]/g, encodeURIComponent);
  } catch { /* No usable public URL. */ }
}
export function external(text: string, url?: string) {
  const dest = webLink(url);
  return dest ? '[' + label(text) + '](<' + dest + '>)' : label(text);
}
function fold(type: string, title: string, content: string, open = false) {
  return '> [!' + type + ']' + (open ? '+ ' : '- ') + oneLine(title) + '\n' +
    content.split('\n').map(line => '> ' + line).join('\n');
}
function listItem(text: string) { return '- ' + text.replaceAll('\n', '\n  '); }
function citations(v: NodeVersion) {
  return exportSourceEntries(v).map(e => listItem(e.marker + ' ' + external(e.label, e.url) +
    (e.excerpt ? '\n\n' + e.excerpt.trim() : ''))).join('\n');
}

export async function nodeNote(p: Project, node: ScatterNode, names: Map<string, string>, title: string,
  media: (m: MediaRef) => Promise<string>, projectSources: string[], programLink?: string) {
  const v = node.versions[node.currentVersionIndex];
  // Canvas already displays the note title. Only repeat it when sanitizing,
  // shortening or disambiguating its filename would lose part of the title.
  const sections = names.get(node.id) === title ? [] : ['# ' + label(title)];
  const sources: string[] = [];
  const previews = new Map<string, string>();
  const glossary: string[] = [];
  const termWriter = (answer: NodeVersion, children: ReadonlyMap<string, string>) => {
    const saved = answer.termPreviews;
    const entries = saved && saved.fingerprint === termPreviewFingerprint(answer) ? saved.entries : undefined;
    return (raw: string, description?: string) => {
      const t = wholeTerm(raw), target = names.get(children.get(t) ?? '');
      if (target) return localLink(t, './' + target + '.md');
      const key = termPreviewKey(t);
      const preview = description || (entries && Object.hasOwn(entries, key) && entries[key]);
      if (!preview) return stripChipMarkers(raw);
      const identity = t + '\n' + preview;
      let block = previews.get(identity);
      if (!block) {
        block = 'term-' + (previews.size + 1);
        previews.set(identity, block);
        glossary.push('**' + label(t) + '** — ' + oneLine(stripChipMarkers(preview)) + ' ^' + block);
      }
      return '[' + label(t) + '](<../Previews/' + encodeURIComponent(names.get(node.id)!) + '.md#^' + block + '>)';
    };
  };
  if (node.chat) {
    const path = conversationPath(node);
    for (const [i, ref] of path.entries()) {
      const answer = answerVersion(node, ref);
      if (!answer?.chat) continue;
      const question = answer.chat.question;
      const children = nodeRelations(p.arrows, node.id, ref).childByTerm;
      const body = replaceTermMarkers(answer.body, termWriter(answer, children));
      const parts: string[] = [];
      if (/[\r\n]/.test(question)) parts.push(question);
      for (const attachment of answer.chat.attachments ?? []) {
        if (attachment.media) parts.push(await media(attachment.media));
        else if (attachment.text) parts.push(fold('attachment', label(attachment.name), attachment.text));
      }
      if (body) parts.push(listItem('**Answer**\n\n' + body));
      sections.push(listItem(fold('question', label(question.split('\n')[0]!) || 'Question', parts.join('\n\n'), i === path.length - 1)));
      const refs = citations(answer);
      if (refs) sources.push('**' + label(question) + '**\n\n' + refs);
    }
  } else if (v) {
    const children = nodeRelations(p.arrows, node.id).childByTerm;
    const term = termWriter(v, children);
    const mark = (s: string) => replaceTermMarkers(s, term);
    const parsed = currentContentType(node) === 'encyclopedic' && parseBody(v.body);
    if (v.media) sections.push(await media(v.media));
    if (programLink) sections.push(programLink);
    if (parsed && parsed.bullets.length) {
      sections.push(mark(parsed.freeText));
      for (const bullet of parsed.bullets) {
        const name = term(bullet.title);
        const items = bullet.children.map(c => listItem(term(c.name, c.desc) + (c.desc ? ': ' + mark(c.desc) : '')));
        sections.push(items.length ? fold('abstract', name, items.join('\n')) : listItem(name));
      }
    } else sections.push(mark(v.body));
    sources.push(citations(v));
  }
  if (node.id === p.rootNodeId && projectSources.length) sources.push('**Project source library**\n\n' + projectSources.map(listItem).join('\n'));
  if (sources.some(Boolean)) sections.push(fold('cite', 'Sources', sources.filter(Boolean).join('\n\n')));
  return { note: sections.filter(Boolean).join('\n\n') + '\n', glossary: glossary.join('\n\n') };
}
