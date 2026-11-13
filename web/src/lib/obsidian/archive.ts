import JSZip from 'jszip';
import type { MediaRef, Project } from '@/store/types';
import { estimatedNodeHeight, nodeWidth } from '../nodeSize';
import { resolveColorHex, hexToRgb, mutedAccentHex } from '../groupColor';
import { decodeSourceDocument } from '../sourceCodec';
import { stringHash } from '../stringHash';
import { standaloneInteractive } from './interactive';
import { external, localLink, nodeNote, webLink } from './markdown';

/** Obsidian link syntax, Windows reserved names, and interoperable UTF-8
 * lengths all apply even when the ZIP is created on another operating system. */
function fileStem(s: string, fallback: string) {
  const clean = s.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|#%^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const stem = [...clean].slice(0, 44).join('').replace(/^[. ]+|[. ]+$/g, '') || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem) ? '_' + stem : stem;
}
function nameAllocator() {
  const used = new Set<string>();
  return (base: string) => {
    let next = base, i = 1;
    while (used.has(next.toLowerCase())) next = base + ' (' + ++i + ')';
    used.add(next.toLowerCase());
    return next;
  };
}
const extensions: Record<string, string> = {
  'image/png':'png', 'image/jpeg':'jpg', 'image/gif':'gif', 'image/webp':'webp', 'image/svg+xml':'svg',
  'image/avif':'avif', 'image/bmp':'bmp', 'image/tiff':'tif', 'image/heic':'heic',
  'video/mp4':'mp4', 'video/webm':'webm', 'video/quicktime':'mov', 'video/ogg':'ogv', 'video/x-matroska':'mkv',
};
const safeId = (id: string) => !!id && id !== '.' && id !== '..' && !/[/\\\u0000-\u001f]/.test(id);
const coord = (n: number) => Number.isFinite(n) ? Math.round(n) : 0;
type Card = { id: string; type: 'file'; file: string; x: number; y: number; width: number; height: number; color?: string };
const instructions = [
  '# Open the canvas in Obsidian', '',
  'Extract the entire ZIP at the top level of an Obsidian vault. Keep the project folder name and its contents together: Canvas file paths start at the vault root.',
  'Open the .canvas file. Each card is backed by an editable Markdown note. Connected terms link to the corresponding note. Other terms with a saved definition link to a block in Previews. Enable the Page preview core plugin to preview links; hold Ctrl (Cmd on macOS) if your Obsidian settings require it.',
  'Read notes in Reading view for the initial fold states. Earlier questions and encyclopedia sections are folded; the last question is open. Sources are folded at the end of each note.',
  'Open interactive HTML files in a browser. If Obsidian hides HTML files, enable Settings → Files and links → Detect all file extensions, or open the Interactive folder in your file manager.',
  'This is an export of the current canvas and selected conversation answers, not a restorable project backup. It does not include other versions, API keys, or your settings.', '',
].join('\n\n');

interface Options {
  readSource?: (id: string) => Promise<Blob | null>;
  accents?: { hue: number; desaturate: number; darken: number; theme: 'light' | 'dark' };
}
export async function buildObsidianArchive(project: Project, readAsset: (id: string) => Promise<Blob | null>, options: Options = {}) {
  const zip = new JSZip(), projectName = fileStem(project.name, 'Project');
  const folder = projectName + ' - ' + stringHash(project.id);
  const put = (path: string, content: string) => zip.file(folder + '/' + path, content);
  const names = new Map<string, string>(), titles = new Map<string, string>(), reserve = nameAllocator();
  const nodes = Object.values(project.nodes);
  for (const node of nodes) {
    const title = node.chat?.title || node.versions[node.currentVersionIndex]?.header || 'Untitled node';
    titles.set(node.id, title);
    names.set(node.id, reserve(fileStem(title, 'Untitled node')));
  }
  const mediaNames = nameAllocator(), mediaPaths = new Map<string, string>();
  const missing = new Set<string>();
  const media = async (m: MediaRef) => {
    const attribution = m.freeImage ?? m.wikimedia;
    const creditUrl = m.freeImage?.landingPageUrl ?? m.wikimedia?.filePageUrl;
    const remote = webLink(m.url) ?? webLink(attribution?.originalUrl) ??
      (m.provider && m.embedId ? webLink((m.provider === 'youtube' ? 'https://www.youtube.com/watch?v=' : 'https://vimeo.com/') + encodeURIComponent(m.embedId)) : undefined);
    let local: string | undefined;
    if (m.source === 'asset' && m.assetId && safeId(m.assetId)) {
      local = mediaPaths.get(m.assetId);
      if (!local && !missing.has(m.assetId)) {
        const bytes = await readAsset(m.assetId);
        if (bytes) {
          const suffix = m.fileName?.split('.').pop()?.toLowerCase();
          const ext = extensions[(m.mime || bytes.type).split(';')[0]!.toLowerCase()] ||
            (suffix && Object.values(extensions).includes(suffix) ? suffix : 'bin');
          local = 'Media/' + mediaNames(fileStem(m.fileName?.replace(/\.[^.]+$/, '') || m.kind, 'Media')) + '.' + ext;
          zip.file(folder + '/' + local, new Uint8Array(await bytes.arrayBuffer()), { compression: 'STORE' });
          mediaPaths.set(m.assetId, local);
        } else missing.add(m.assetId);
      }
    }
    const remoteEmbed = m.kind === 'image' ? '![Image](<' + remote + '>)' :
      m.provider === 'youtube' ? '![](<' + remote + '>)' :
      m.provider === 'vimeo' && /^\d+$/.test(m.embedId || '') ? '<iframe src="https://player.vimeo.com/video/' + m.embedId + '" title="Vimeo video" loading="lazy"></iframe>' :
      m.kind === 'video' && remote ? '<video controls preload="none" src="' + remote.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"></video>' : '';
    const result = local ? localLink(m.fileName || m.kind, '../' + local, !local.endsWith('.bin')) : remote ?
      (remoteEmbed ? remoteEmbed + '\n\n' : '') + '[Open original media](<' + remote + '>)' :
      'Media unavailable: no local file or original URL was available at export.';
    const source = webLink(creditUrl), license = webLink(attribution?.licenseUrl);
    return [result, attribution?.creditLine, source && '[Image source](<' + source + '>)', license && '[License](<' + license + '>)'].filter(Boolean).join('\n\n');
  };
  const projectSources: string[] = [], sourceNames = nameAllocator();
  for (const source of Object.values(project.sourceLibrary?.sources ?? {})) {
    const revision = source.revisions[source.activeRevisionId];
    let file: string | undefined;
    const stem = sourceNames(fileStem(source.title, 'Source'));
    if (options.readSource && revision) {
      const id = revision.originalAssetId;
      const original = id && safeId(id) && (source.kind === 'pdf' || source.kind === 'docx') && await options.readSource(id);
      if (original) {
        file = 'Sources/' + stem + '.' + source.kind;
        zip.file(folder + '/' + file, new Uint8Array(await original.arrayBuffer()), { compression: 'STORE' });
      } else if (safeId(revision.contentAssetId)) {
        const stored = await options.readSource(revision.contentAssetId);
        if (stored) {
          // A damaged or unsupported source must not prevent the rest of the
          // project from being exported. Keep its citation/link in that case.
          const doc = await decodeSourceDocument(stored).catch(() => null);
          if (doc) {
            file = 'Sources/' + stem + '.md';
            put(file, doc.blocks.map(b => b.text).join('\n\n'));
          }
        }
      }
    }
    projectSources.push(file ? localLink(source.title, '../' + file) : external(source.title, source.originalUrl));
  }
  const cards: Card[] = [];
  for (const node of nodes) {
    const stem = names.get(node.id)!, title = titles.get(node.id)!, v = node.versions[node.currentVersionIndex];
    const accent = (node.groupId && project.groups[node.groupId]?.color) || project.color;
    const rgb = accent && hexToRgb(resolveColorHex(accent));
    const color = rgb ? '#' + rgb.map(n => n.toString(16).padStart(2,'0')).join('') : undefined;
    let interactiveLink: string | undefined;
    if (v?.interactive?.html) {
      const path = 'Interactive/' + stem + '.html';
      put(path, standaloneInteractive(v.interactive, title, color));
      interactiveLink = localLink('Open interactive in browser', '../' + path);
    }
    const file = 'Notes/' + stem + '.md';
    const { note, glossary } = await nodeNote(project, node, names, title, media, projectSources, interactiveLink);
    put(file, note);
    if (glossary) put('Previews/' + stem + '.md', glossary);
    cards.push({ id: node.id, type: 'file', file: folder + '/' + file, color,
      x: coord(node.position.x), y: coord(node.position.y), width: Math.max(1, coord(nodeWidth(node))),
      height: Math.max(1, coord(node.renderedHeight || estimatedNodeHeight(node))) });
  }
  const byId = new Map(cards.map(c => [c.id,c]));
  const edges = Object.values(project.arrows).flatMap(a => {
    const from = byId.get(a.fromNodeId), to = byId.get(a.toNodeId);
    if (!from || !to) return [];
    const dx = to.x + to.width / 2 - from.x - from.width / 2, dy = to.y + to.height / 2 - from.y - from.height / 2;
    const horizontal = Math.abs(dx) / (from.width + to.width) >= Math.abs(dy) / (from.height + to.height);
    return [{ id: a.id, fromNode: from.id, toNode: to.id, fromEnd: 'none', toEnd: 'arrow',
      fromSide: horizontal ? (dx >= 0 ? 'right':'left') : (dy >= 0 ? 'bottom':'top'),
      toSide: horizontal ? (dx >= 0 ? 'left':'right') : (dy >= 0 ? 'top':'bottom'),
      color: options.accents ? mutedAccentHex(from.color, options.accents.hue, options.accents.desaturate, options.accents.darken, options.accents.theme, .58) : from.color,
      label: a.label || undefined }];
  });
  put(projectName + '.canvas', JSON.stringify({ nodes: cards, edges }, null, 2));
  put('Open in Obsidian.md', instructions);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
  return { blob, filename: projectName + '.obsidian.zip', missingMedia: missing.size };
}
