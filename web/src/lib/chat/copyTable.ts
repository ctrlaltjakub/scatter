/** Rich table for document/spreadsheet paste; TSV fallback for plain-text apps. */
export async function copyTable(table: HTMLTableElement): Promise<void> {
  const text = [...table.rows].map(row => [...row.cells].map(cell => {
    const copy = cell.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    const value = (cell.innerText ?? copy.textContent ?? '').trim();
    return /[\t\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join('\t')).join('\n');
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const html = table.cloneNode(true) as HTMLTableElement;
      for (const element of [html, ...html.querySelectorAll('*')]) for (const attribute of [...element.attributes]) {
        if (/^(?:data-|aria-)/.test(attribute.name) || ['class', 'role', 'tabindex'].includes(attribute.name)) element.removeAttribute(attribute.name);
      }
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html.outerHTML], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return;
    } catch { /* Some browsers support only plain-text clipboard writes. */ }
  }
  await navigator.clipboard.writeText(text);
}
