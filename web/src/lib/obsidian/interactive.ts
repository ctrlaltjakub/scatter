import type { InteractiveExplanation } from '@/store/types';
import { buildInteractiveSrcDoc, resolveInteractiveViewport } from '../interactiveDocument';
import { readInteractiveTheme } from '../interactiveTheme';

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A standalone browser document, not executable markup in an Obsidian note.
 * Keep the program at its authored CSS viewport even on a 4K monitor. Shrink
 * the whole frame on smaller screens instead of reflowing its controls. */
export function standaloneInteractive(program: InteractiveExplanation, title: string, accent?: string) {
  const viewport = resolveInteractiveViewport(program);
  const { width, height } = viewport;
  const theme = { ...readInteractiveTheme(accent) };
  // App cursor URLs may be relative to the installation; an offline export
  // must not depend on them. The sandbox supplies its standard cursor fallbacks.
  delete theme.cursors;
  const html = /<html(?:\s|>)/i.test(program.html) ? program.html : '<html><head></head><body>' + program.html + '</body></html>';
  const doc = buildInteractiveSrcDoc(html, 'offline', { active: true, theme }, viewport);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src \'self\' about:; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; media-src data: blob:; base-uri \'none\'; form-action \'none\'">' +
    '<title>' + escape(title) + '</title><style>html,body{margin:0;height:100%;overflow:hidden;background:' +
    (theme.mode === 'dark' ? '#101010' : '#fafafa') + '}iframe{position:absolute;left:50%;top:50%;border:0;width:' + width + 'px;height:' + height +
    'px;transform:translate(-50%,-50%) scale(var(--scale,1))}</style></head><body>' +
    '<script>function fit(){document.documentElement.style.setProperty("--scale",Math.min(1,innerWidth/' + width + ',innerHeight/' + height + '))}fit();addEventListener("resize",fit)</script>' +
    '<iframe title="' + escape(title) + '" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="' + escape(doc) + '"></iframe></body></html>';
}
