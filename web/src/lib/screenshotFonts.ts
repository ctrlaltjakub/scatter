import { useSettingsStore } from '@/store/useSettingsStore';
import { customFontFamily } from './customNodeFonts';

const cache = new Map<string, Promise<string>>();
const normalize = (family: string) => family.trim().replace(/["']/g, '').toLowerCase();
function inlineFont(url: string): Promise<string> {
  let value = cache.get(url);
  if (!value) {
    value = fetch(url).then(async response => {
      if (!response.ok) throw new Error('An app font could not load for export. Reload and retry.');
      const blob = await response.blob();
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob);
      });
    }).catch(error => { cache.delete(url); throw error; });
    cache.set(url, value);
  }
  return value;
}
/** Use standard CSS descriptor access: Firefox's font-face declarations do
 * not expose the .fontFamily shortcut used by html-to-image 1.11.13. */
export async function screenshotFontCSS(): Promise<string> {
  const families = new Set<string>();
  const characters = new Set<number>();
  for (const element of document.body.querySelectorAll('*')) {
    if (element.closest('[data-sc-capture-exclude]') || ['SCRIPT', 'STYLE'].includes(element.tagName)) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    style.fontFamily.split(',').forEach(family => families.add(normalize(family)));
    for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE) {
      for (const char of node.textContent ?? '') characters.add(char.codePointAt(0)!);
    }
  }
  const usedRange = (ranges: string) => !ranges || ranges.split(',').some(range => {
    const [a, b = a] = range.trim().replace(/^U\+/i, '').split('-');
    const min = parseInt(a!.replace(/\?/g, '0'), 16), max = parseInt(b!.replace(/\?/g, 'f'), 16);
    return [...characters].some(code => code >= min && code <= max);
  });
  const rules: CSSFontFaceRule[] = [];
  const collect = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule.type === CSSRule.FONT_FACE_RULE) rules.push(rule as CSSFontFaceRule);
      else if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules);
      else if (rule.type === CSSRule.IMPORT_RULE && (rule as CSSImportRule).styleSheet) collect((rule as CSSImportRule).styleSheet!.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { collect(sheet.cssRules); }
    catch { throw new Error('A stylesheet blocks font export. Use locally loaded app fonts and retry.'); }
  }
  const faces = await Promise.all(rules.filter(rule => families.has(normalize(rule.style.getPropertyValue('font-family')))
    && usedRange(rule.style.getPropertyValue('unicode-range'))).map(async rule => {
    const style = rule.style;
    const urls = [...style.getPropertyValue('src').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map(match => match[1]!);
    const source = urls.find(url => /\.woff2(?:$|\?)/.test(url)) ?? urls[0];
    if (!source) return '';
    const data = source.startsWith('data:') ? source : await inlineFont(new URL(source, rule.parentStyleSheet?.href || location.href).href);
    const descriptors = ['font-family', 'font-style', 'font-weight', 'font-stretch', 'unicode-range', 'size-adjust', 'ascent-override', 'descent-override', 'line-gap-override']
      .map(name => style.getPropertyValue(name) ? `${name}:${style.getPropertyValue(name)};` : '').join('');
    return `@font-face{${descriptors}src:url("${data}")}`;
  }));
  for (const font of useSettingsStore.getState().customNodeFonts ?? []) {
    const family = customFontFamily(font.id);
    if (family && families.has(normalize(family))) faces.push(`@font-face{font-family:"${family}";src:url("data:font/${font.format};base64,${font.data}")}`);
  }
  return faces.join('\n');
}
