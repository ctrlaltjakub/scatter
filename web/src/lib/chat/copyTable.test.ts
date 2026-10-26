import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTable } from './copyTable';

afterEach(() => vi.unstubAllGlobals());
describe('table clipboard', () => {
  it('copies tabs, multiline cells, quotes and Markdown formatting as plain spreadsheet text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const table = document.createElement('table');
    table.innerHTML = '<tr><th>Name</th><th>Value</th></tr><tr><td><strong>A</strong></td><td>First<br>Second "quoted"</td></tr>';
    await copyTable(table);
    expect(writeText).toHaveBeenCalledWith('Name\tValue\nA\t"First\nSecond ""quoted"""');
  });
  it('offers both HTML and text to rich clipboard consumers', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { write } });
    vi.stubGlobal('ClipboardItem', class { constructor(public contents: Record<string, Blob>) {} });
    const table = document.createElement('table');
    table.innerHTML = '<tr><td><b>Text</b></td></tr>';
    await copyTable(table);
    expect(Object.keys(write.mock.calls[0]![0][0].contents)).toEqual(['text/html', 'text/plain']);
  });
});
