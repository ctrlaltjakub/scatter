'use client';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Bold, Italic, Strikethrough, Code, List, ListOrdered, ListTodo, Quote, SquareCode, Link, Image, Table,
  Minus, Eraser, Unlink, ChevronDown, Highlighter, Sigma, Percent, FilePenLine, Upload, X, Heading1,
  Heading2, Heading3, Heading4, Heading5, Heading6, Pilcrow, Braces, Plus } from 'lucide-react';
import { addRowAfter, addRowBefore, addColumnAfter, addColumnBefore, deleteRow, deleteColumn, deleteTable, selectedRect } from '@tiptap/pm/tables';
import type { Command } from '@tiptap/pm/state';
import { normalizeEditorUrl } from '@/lib/chat/markdownExtras';
import { answerBodyToDoc } from '@/lib/answerEditorSerialize';
import { clearMarkdownFormatting, editorPlainText, editMarkdownSource, type MarkdownAction, type SourceEdit, type SourceSelection } from './markdownCommands';

type Panel = 'link' | 'image' | 'table' | 'math' | 'mathBlock' | 'footnote';
interface Props {
  editor: Editor | null;
  disabled: boolean;
  sourceMode?: boolean;
  onToggleSource?: (sourceMode: boolean) => void;
  source?: { get: () => SourceSelection; set: (value: SourceEdit) => void };
}
const headings = [Heading1, Heading2, Heading3, Heading4, Heading5, Heading6];

/** Both editing modes use the same controls and Markdown storage format. */
export function MarkdownEditorToolbar({ editor, disabled, sourceMode = false, onToggleSource, source }: Props) {
  const [, refresh] = useReducer(n => n + 1, 0);
  const [menu, setMenu] = useState<'style' | 'format' | 'insert' | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const openRef = useRef<(next: Panel) => void>(() => {});
  useEffect(() => {
    if (!editor) return;
    editor.on('transaction', refresh);
    const dom = editor.view.dom;
    const edit = (event: Event) => openRef.current((event as CustomEvent<Panel>).detail);
    dom.addEventListener('markdown-edit-target', edit);
    return () => { editor.off('transaction', refresh); dom.removeEventListener('markdown-edit-target', edit); };
  }, [editor]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenu(null); };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [menu]);
  useEffect(() => {
    if (!menu && !panel) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); setMenu(null); setPanel(null); if (!source) editor?.view.focus();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [menu, panel, editor, source]);
  if (!editor) return null;

  const focus = () => { if (!source) editor.view.focus(); };
  const run = (action: MarkdownAction) => {
    setMenu(null);
    if (source) {
      const selection = source.get();
      const doc = action === 'clear' ? editor.schema.nodeFromJSON(answerBodyToDoc(selection.text.slice(selection.from, selection.to))) : null;
      source.set(editMarkdownSource(selection, action, doc ? editorPlainText(doc) : undefined));
      return;
    }
    // Focus synchronously so a quick next keystroke keeps the stored marks.
    focus();
    const chain = editor.chain();
    if (['bold', 'italic', 'strike', 'highlight', 'comment', 'code'].includes(action)) chain.toggleMark(action).run();
    else if (/^h[1-6]$/.test(action)) chain.setNode('heading', { level: Number(action.slice(1)) }).run();
    else if (action === 'body') chain.setNode('paragraph').run();
    else if (action === 'bullet' || action === 'numbered') chain.toggleList(action === 'bullet' ? 'bulletList' : 'orderedList', 'listItem').run();
    else if (action === 'task') {
      if (!editor.isActive('listItem')) chain.toggleList('bulletList', 'listItem').run();
      editor.commands.updateAttributes('listItem', { checked: editor.getAttributes('listItem').checked == null ? false : null });
    } else if (action === 'quote') chain.toggleWrap('blockquote').run();
    else if (action === 'codeBlock') chain.toggleNode('codeBlock', 'paragraph').run();
    else if (action === 'rule') chain.insertContent({ type: 'horizontalRule' }).run();
    else if (action === 'callout') chain.insertContent(answerBodyToDoc('> [!note]\n> Callout text').content ?? []).run();
    else if (action === 'clear') clearMarkdownFormatting(editor);
    focus();
  };
  const insertSource = (value: string) => {
    if (!source) return;
    const current = source.get();
    source.set({ text: current.text.slice(0, current.from) + value + current.text.slice(current.to), from: current.from + value.length, to: current.from + value.length });
  };
  const button = (name: string, Icon: typeof Bold, action: () => void, active?: boolean) => <button
    key={name} type="button" aria-label={name} aria-pressed={active} disabled={disabled}
    onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} onClick={action}><Icon size={16} /></button>;
  const item = (name: string, Icon: typeof Bold, action: () => void, className = '') => <button key={name} type="button" role="menuitem"
    className={className} onMouseDown={event => event.preventDefault()} onClick={action}><Icon size={17} /><span>{name}</span></button>;
  const block = !source && editor.isActive('heading') ? `Heading ${editor.getAttributes('heading').level}` : 'Body';
  const open = (next: Panel) => {
    setMenu(null); setPanel(next); setError('');
    if (source) {
      const current = source.get(), selected = current.text.slice(current.from, current.to);
      const match = selected.match(/^!?\[([^\]]*)\]\(([^)]+)\)$/);
      setUrl(match?.[2] ?? ''); setLabel(match?.[1] ?? selected);
      return;
    }
    if (next === 'link' && editor.isActive('link')) editor.commands.extendMarkRange('link');
    const attrs = editor.getAttributes(next === 'link' ? 'link' : next === 'image' ? 'answerImage' : 'inlineMath');
    setUrl(next === 'link' ? attrs.href ?? '' : next === 'image' ? attrs.src ?? '' : '');
    setLabel(next === 'image' ? attrs.alt ?? '' : next === 'math' ? attrs.value ?? '' : editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ', ' '));
  };
  openRef.current = open;
  const runTable = (command: Command) => { focus(); editor.commands.command(({ state, dispatch }) => command(state, dispatch)); };
  const insertImage = (src: string, alt: string) => {
    if (source) insertSource(`![${alt.replace(/[\[\]]/g, '')}](${src})`);
    else if (editor.isActive('answerImage')) editor.chain().updateAttributes('answerImage', { src, alt }).run();
    else editor.chain().insertContent({ type: 'answerImage', attrs: { src, alt } }).run();
  };
  return <div ref={root} className="markdown-editor-tools" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && (panel || menu)) { event.preventDefault(); setPanel(null); setMenu(null); focus(); }
  }}>
    <div className="markdown-editor-toolbar" role="toolbar" aria-label="Markdown formatting">
      <button type="button" className="markdown-menu-trigger" aria-label="Text style" aria-haspopup="menu" aria-expanded={menu === 'style'} disabled={disabled}
        onMouseDown={event => event.preventDefault()} onClick={() => setMenu(menu === 'style' ? null : 'style')}><Pilcrow size={15} /><span>{block}</span><ChevronDown size={13} /></button>
      {button('Bold', Bold, () => run('bold'), !source && editor.isActive('bold'))}
      {button('Italic', Italic, () => run('italic'), !source && editor.isActive('italic'))}
      <button type="button" className="markdown-menu-trigger" aria-haspopup="menu" aria-expanded={menu === 'format'} disabled={disabled}
        onMouseDown={event => event.preventDefault()} onClick={() => setMenu(menu === 'format' ? null : 'format')}>Format <ChevronDown size={13} /></button>
      <span className="markdown-toolbar-divider" />
      {button('Link', Link, () => open('link'), !source && editor.isActive('link'))}
      {button('Image', Image, () => open('image'))}
      {button('Table', Table, () => open('table'))}
      <button type="button" className="markdown-menu-trigger" aria-haspopup="menu" aria-expanded={menu === 'insert'} disabled={disabled}
        onMouseDown={event => event.preventDefault()} onClick={() => setMenu(menu === 'insert' ? null : 'insert')}><Plus size={15} /> Insert <ChevronDown size={13} /></button>
      {onToggleSource && <div className="markdown-mode-switch" role="group" aria-label="Editing mode">
        <button type="button" aria-pressed={!sourceMode} disabled={disabled}
          onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()}
          onClick={() => onToggleSource(false)}>Visual</button>
        <button type="button" aria-pressed={sourceMode} disabled={disabled}
          onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()}
          onClick={() => onToggleSource(true)}><Braces size={14} /> Source</button>
      </div>}
    </div>
    {menu && <div className={`markdown-format-menu markdown-format-menu--${menu}`} role="menu" aria-label={menu === 'style' ? 'Text style' : menu === 'format' ? 'Formatting' : 'Insert'}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {menu === 'style' && <>
        {item('Bullet list', List, () => run('bullet'))}{item('Numbered list', ListOrdered, () => run('numbered'))}{item('Task list', ListTodo, () => run('task'))}
        <hr />{headings.map((Icon, index) => item(`Heading ${index + 1}`, Icon, () => run(`h${index + 1}`), `markdown-heading-preview h${index + 1}`))}
        {item('Body', Pilcrow, () => run('body'))}<hr />{item('Quote', Quote, () => run('quote'))}
      </>}
      {menu === 'format' && <>
        {item('Bold', Bold, () => run('bold'))}{item('Italic', Italic, () => run('italic'))}{item('Strikethrough', Strikethrough, () => run('strike'))}
        {item('Highlight', Highlighter, () => run('highlight'))}<hr />{item('Code', Code, () => run('code'))}
        {item('Math', Sigma, () => open('math'))}{item('Comment', Percent, () => run('comment'))}<hr />{item('Clear formatting', Eraser, () => run('clear'))}
      </>}
      {menu === 'insert' && <>
        {item('Footnote', FilePenLine, () => open('footnote'))}{item('Table', Table, () => open('table'))}
        {item('Callout', Quote, () => run('callout'))}{item('Horizontal rule', Minus, () => run('rule'))}<hr />
        {item('Code block', SquareCode, () => run('codeBlock'))}{item('Math block', Sigma, () => open('mathBlock'))}
      </>}
    </div>}
    {!source && editor.isActive('codeBlock') && <label className="markdown-code-language">Code language
      <input className="input" aria-label="Code language" placeholder="e.g. javascript" value={editor.getAttributes('codeBlock').language ?? ''}
        disabled={disabled} onChange={event => editor.commands.updateAttributes('codeBlock', { language: event.target.value })} />
    </label>}
    {!source && editor.isActive('table') && <div className="markdown-table-tools" role="toolbar" aria-label="Table editing">
      {([['Row above', addRowBefore], ['Row below', addRowAfter], ['Column left', addColumnBefore], ['Column right', addColumnAfter],
        ['Delete row', deleteRow], ['Delete column', deleteColumn], ['Delete table', deleteTable]] as const).map(([name, command]) =>
        <button key={name} type="button" disabled={disabled || !command(editor.state)} onMouseDown={event => event.preventDefault()} onClick={() => runTable(command)}>{name}</button>)}
      <select className="input" aria-label="Column alignment" disabled={disabled}
        value={editor.getAttributes(editor.isActive('tableHeader') ? 'tableHeader' : 'tableCell').align ?? ''}
        onChange={event => {
          const align = event.target.value || null;
          editor.commands.command(({ state, tr, dispatch }) => {
            const rect = selectedRect(state);
            if (dispatch) for (let row = 0; row < rect.map.height; row++) {
              const pos = rect.tableStart + rect.map.map[row * rect.map.width + rect.left]!;
              tr.setNodeMarkup(pos, undefined, { ...tr.doc.nodeAt(pos)!.attrs, align });
            }
            return true;
          }); focus();
        }}><option value="">Column alignment</option><option value="left">Align left</option><option value="center">Align center</option><option value="right">Align right</option></select>
    </div>}
    {panel && <form className="markdown-insert-form" aria-label={`Edit ${panel}`} onSubmit={event => {
      event.preventDefault(); focus();
      if (panel === 'table') {
        const count = (value: number) => Math.max(1, Math.min(20, Math.round(value) || 1));
        if (source) insertSource(`\n\n| ${Array(count(columns)).fill('Column').join(' | ')} |\n| ${Array(count(columns)).fill('---').join(' | ')} |\n${Array.from({ length: count(rows) - 1 }, () => `| ${Array(count(columns)).fill(' ').join(' | ')} |`).join('\n')}\n`);
        else editor.commands.insertContent({ type: 'table', content: Array.from({ length: count(rows) }, (_, row) => ({
          type: 'tableRow', content: Array.from({ length: count(columns) }, () => ({ type: row === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph' }] })),
        })) });
      } else if (panel === 'math' || panel === 'mathBlock') {
        if (source) insertSource(panel === 'math' ? `$${label}$` : `\n\n$$\n${label}\n$$\n`);
        else if (panel === 'math' && editor.isActive('inlineMath')) editor.commands.updateAttributes('inlineMath', { value: label });
        else editor.commands.insertContent(panel === 'math' ? { type: 'inlineMath', attrs: { value: label } } : { type: 'mathBlock', content: label ? [{ type: 'text', text: label }] : [] });
      } else if (panel === 'footnote') {
        const used = new Set<string>(); editor.state.doc.descendants(node => { if (node.type.name === 'footnoteDefinition') used.add(String(node.attrs.identifier)); });
        let id = 1; while (used.has(String(id)) || (source && source.get().text.includes(`[^${id}]`))) id++;
        if (source) {
          const current = source.get(), ref = `[^${id}]`;
          source.set({ text: current.text.slice(0, current.from) + ref + current.text.slice(current.to) + `\n\n[^${id}]: ${label}`, from: current.from + ref.length, to: current.from + ref.length });
        } else {
          editor.commands.insertContent({ type: 'footnoteReference', attrs: { identifier: String(id) } });
          editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'footnoteDefinition', attrs: { identifier: String(id) }, content: [{ type: 'paragraph', content: label ? [{ type: 'text', text: label }] : [] }] });
        }
      } else {
        const value = normalizeEditorUrl(url, panel === 'image');
        if (!value) { setError('Enter a valid http://, https://, or www. address' + (panel === 'link' ? ', mailto: link, or local path.' : ', or choose an image file.')); return; }
        if (panel === 'image') insertImage(value, label);
        else if (source) insertSource(`[${label || value}](${value})`);
        else if (editor.state.selection.empty || label !== editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ', ' ')) editor.commands.insertContent({ type: 'text', text: label || value, marks: [{ type: 'link', attrs: { href: value } }] });
        else editor.chain().extendMarkRange('link').setMark('link', { href: value }).run();
      }
      setPanel(null); setError(''); focus();
    }}>
      <div className="markdown-insert-heading"><strong>{({ link: 'Link', image: 'Image', table: 'Table', math: 'Math', mathBlock: 'Math block', footnote: 'Footnote' })[panel]}</strong>
        <button type="button" aria-label="Close insert panel" onClick={() => { setPanel(null); focus(); }}><X size={16} /></button></div>
      <div className="markdown-insert-fields">
        {panel === 'table' ? <>
          <label>Rows<input className="input" type="number" min={1} max={20} value={rows} onChange={event => setRows(Number(event.target.value))} /></label>
          <label>Columns<input className="input" type="number" min={1} max={20} value={columns} onChange={event => setColumns(Number(event.target.value))} /></label>
          <div className="markdown-table-preview" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${Math.min(8, columns) || 1}, 1fr)` }}>{Array.from({ length: Math.max(1, Math.min(6, rows) * Math.min(8, columns)) }, (_, i) => <span key={i} />)}</div>
        </> : panel === 'link' || panel === 'image' ? <>
          <label>{panel === 'image' ? 'Image URL' : 'Link URL'}<input className="input" autoFocus value={url.startsWith('data:') ? '' : url} onChange={event => setUrl(event.target.value)} placeholder={url.startsWith('data:') ? 'Embedded image · enter a URL to replace it' : 'https://example.com or www.example.com'} /></label>
          <label>{panel === 'image' ? 'Alternative text' : 'Link text'}<input className="input" value={label} onChange={event => setLabel(event.target.value)} /></label>
        </> : <label>{panel === 'footnote' ? 'Footnote text' : 'LaTeX expression'}<textarea className="input" autoFocus rows={3} value={label} onChange={event => setLabel(event.target.value)} /></label>}
      </div>
      <div className="markdown-insert-actions">
        {panel === 'image' && <>
          <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden onChange={async event => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
            if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type) || file.size > 10 * 1024 * 1024) { setError('Choose a PNG, JPEG, WebP, GIF, or AVIF image up to 10 MB.'); return; }
            try {
              const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
              insertImage(data, label || file.name); setPanel(null); focus();
            } catch { setError('The image could not be read. Please try again.'); }
          }} />
          <button type="button" className="btn" onClick={() => upload.current?.click()}><Upload size={15} /> Choose file</button>
        </>}
        {panel === 'link' && !source && editor.isActive('link') && <button type="button" className="btn" onClick={() => { editor.chain().extendMarkRange('link').unsetMark('link').run(); setPanel(null); focus(); }}><Unlink size={15} /> Remove link</button>}
        <span /><button type="button" className="btn" onClick={() => { setPanel(null); focus(); }}>Cancel</button>
        <button type="submit" className="btn markdown-apply" disabled={disabled}>Apply</button>
      </div>
      {error && <span role="alert">{error}</span>}
    </form>}
  </div>;
}
