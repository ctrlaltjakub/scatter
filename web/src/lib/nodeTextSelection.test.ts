import { afterEach, describe, expect, it } from 'vitest';
import { resolveNodeTextSelection, sourceFieldProjection } from './nodeTextSelection';

function textNode(el: Element): Text {
  const node = el.firstChild;
  if (!(node instanceof Text)) throw new Error('expected a text node');
  return node;
}

function select(
  root: HTMLElement,
  startField: string,
  startOffset: number,
  endField: string,
  endOffset: number,
): Range {
  const start = root.querySelector(`[data-sc-source-field="${startField}"]`)!;
  const end = root.querySelector(`[data-sc-source-field="${endField}"]`)!;
  const range = document.createRange();
  range.setStart(textNode(start), startOffset);
  range.setEnd(textNode(end), endOffset);
  return range;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('resolveNodeTextSelection', () => {
  it('retains source offsets through multiline emphasis, blank lines and supplementary CJK characters', () => {
    const body = '**𠮷野の文。\n次の文。**\n\n[[最後]]の文。';
    const projection = sourceFieldProjection(body, 'ft')!;
    expect(projection.text).toBe('𠮷野の文。 次の文。 最後の文。');
    const at = projection.text.indexOf('最後');
    expect(projection.raw[at]).toBe(body.indexOf('最後'));
    expect(projection.raw[projection.text.indexOf('次')]).toBe(body.indexOf('次'));
  });
  it('keeps chat selections aligned after entities and includes complete escaped characters', () => {
    const body = 'A &amp; B \\*literal\\* and C.';
    document.body.innerHTML = '<div class="chat-markdown"><p data-sc-source-field="chat:0">A &amp; B *literal* and C.</p></div>';
    const root = document.querySelector<HTMLElement>('.chat-markdown')!;
    const range = select(root, 'chat:0', 2, 'chat:0', 15);
    const result = resolveNodeTextSelection({ body, nodeId: 'chat', versionIndex: 1, range, root });
    expect(result?.text).toBe('& B *literal*');
    expect(body.slice(result!.start, result!.end)).toBe('&amp; B \\*literal\\*');
  });
  it('resolves the exact repeated phrase from its semantic source field', () => {
    const body = `Repeated opening.\n\n- Topic\n  - First: repeated alpha\n  - Second: repeated beta`;
    document.body.innerHTML = `
      <div class="sc-ab-root" data-node-id="n1">
        <span data-sc-source-field="b:0:c:0:desc">repeated alpha</span>
        <span data-sc-source-field="b:0:c:1:desc">repeated beta</span>
      </div>`;
    const root = document.querySelector<HTMLElement>('.sc-ab-root')!;
    const range = select(root, 'b:0:c:1:desc', 0, 'b:0:c:1:desc', 8);

    const result = resolveNodeTextSelection({ body, nodeId: 'n1', versionIndex: 2, range, root });

    expect(result).toMatchObject({ nodeId: 'n1', versionIndex: 2, text: 'repeated' });
    expect(body.slice(result!.start, result!.end)).toBe('repeated');
    expect(result!.start).toBe(body.lastIndexOf('repeated'));
  });

  it('maps visible bold, chip, and citation text back to stored markdown offsets', () => {
    const body = '**Alpha** and [[Beta]] ⟦12⟧.';
    document.body.innerHTML = `
      <div class="sc-ab-root" data-node-id="n1">
        <span data-sc-source-field="ft">Alpha and Beta [12].</span>
      </div>`;
    const root = document.querySelector<HTMLElement>('.sc-ab-root')!;
    const visible = root.querySelector('[data-sc-source-field="ft"]')!.textContent!;
    const range = select(root, 'ft', visible.indexOf('Beta'), 'ft', visible.indexOf('[12]') + 4);

    const result = resolveNodeTextSelection({ body, nodeId: 'n1', versionIndex: 0, range, root });

    expect(result!.text).toBe('Beta [12]');
    expect(result!.start).toBe(body.indexOf('Beta'));
    expect(result!.end).toBe(body.indexOf('⟧') + 1);
  });

  it('accounts for render-time heading cleanup without shifting source offsets', () => {
    const body = '### **Alpha** and [[Beta]].';
    document.body.innerHTML = `
      <div class="sc-ab-root"><span data-sc-source-field="ft">Alpha and Beta.</span></div>`;
    const root = document.querySelector<HTMLElement>('.sc-ab-root')!;
    const range = select(root, 'ft', 10, 'ft', 14);

    const result = resolveNodeTextSelection({ body, nodeId: 'n1', versionIndex: 0, range, root });
    expect(result).not.toBeNull();
    expect(body.slice(result!.start, result!.end)).toBe('Beta');
  });

  it('represents a selection crossing visible fields as separate source parts', () => {
    const body = `Opening.\n\n- Topic\n  - First: alpha value\n  - Second: beta value`;
    document.body.innerHTML = `
      <div class="sc-ab-root" data-node-id="n1">
        <span data-sc-source-field="b:0:c:0:desc">alpha value</span>
        <span data-sc-source-field="b:0:c:1:name">Second</span>
        <span data-sc-source-field="b:0:c:1:desc">beta value</span>
      </div>`;
    const root = document.querySelector<HTMLElement>('.sc-ab-root')!;
    const range = select(root, 'b:0:c:0:desc', 6, 'b:0:c:1:desc', 4);

    const result = resolveNodeTextSelection({ body, nodeId: 'n1', versionIndex: 0, range, root });

    expect(result!.parts?.map((part) => body.slice(part.start, part.end))).toEqual([
      'value',
      'Second',
      'beta',
    ]);
    expect(result!.text).toBe('value\nSecond\nbeta');
  });

  it('selects several collapsed bullet titles without including their hidden descriptions', () => {
    const body = `Opening.\n\n- Topic\n  - First title: hidden first description\n  - Second title: hidden second description\n  - Third title: hidden third description`;
    document.body.innerHTML = `
      <div class="sc-ab-root" data-node-id="n1">
        <div class="sc-ab-item" aria-expanded="false">
          <span data-sc-source-field="b:0:c:0:name">First title</span>
          <span data-sc-source-field="b:0:c:1:name">Second title</span>
          <span data-sc-source-field="b:0:c:2:name">Third title</span>
        </div>
      </div>`;
    const root = document.querySelector<HTMLElement>('.sc-ab-root')!;
    const range = select(root, 'b:0:c:0:name', 0, 'b:0:c:2:name', 'Third title'.length);

    const result = resolveNodeTextSelection({ body, nodeId: 'n1', versionIndex: 0, range, root });

    expect(result!.text).toBe('First title\nSecond title\nThird title');
    expect(result!.parts?.map((part) => ({
      field: part.sourceField,
      source: body.slice(part.start, part.end),
    }))).toEqual([
      { field: 'b:0:c:0:name', source: 'First title' },
      { field: 'b:0:c:1:name', source: 'Second title' },
      { field: 'b:0:c:2:name', source: 'Third title' },
    ]);
    expect(result!.parts?.some((part) => body.slice(part.start, part.end).includes('hidden'))).toBe(false);
  });

  it('rejects endpoints that are not source-annotated body text', () => {
    document.body.innerHTML = `<div class="sc-ab-root"><span>plain</span></div>`;
    const root = document.querySelector<HTMLElement>('.sc-ab-root')!;
    const range = document.createRange();
    range.selectNodeContents(root.querySelector('span')!);
    expect(resolveNodeTextSelection({ body: 'plain', nodeId: 'n1', versionIndex: 0, range, root })).toBeNull();
  });
});
