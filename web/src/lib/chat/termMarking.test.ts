import { describe, expect, it, vi } from 'vitest';
import { plain } from '@/lib/chipReveal';
import { applyTermSelection, stripTermMarkers } from '@/lib/termMarking';
import { termSelectionPrompt } from '@/lib/termSelectionPrompt';
import { chatTermBatches, markChatTerms } from './termMarking';

const json = (...terms: string[]) => JSON.stringify({ terms });
const select = (body: string, ...terms: string[]) => applyTermSelection(body, json(...terms));

describe('shared, bounded term selection', () => {
  it('preserves every byte and excludes code blocks from requests', () => {
    const body = '# A heading\n\n' + '**Memory** and cognition.\n'.repeat(1200) + '\n```js\nconst x = 1;\n```\n';
    const batches = chatTermBatches(body);
    expect(batches.map((batch) => batch.text).join('')).toBe(body);
    expect(batches.every((batch) => batch.text.length <= 6000)).toBe(true);
    expect(batches.filter((batch) => batch.skip).map((batch) => batch.text).join('')).toContain('const x = 1');
  });
  it('uses JSON selection on the FIRST attempt, including packed headings', async () => {
    const body = '# Memory\n\nMemory and `Memory` with [Memory](https://example.org).\n\n'.repeat(20);
    expect(chatTermBatches(body)).toHaveLength(1);
    const complete = vi.fn(async () => json('Memory'));
    const result = await markChatTerms(body, new AbortController().signal, complete);
    expect(result.failed).toBe(0);
    expect(result.body).toContain('# [[Memory]]\n');
    expect(result.body).toContain('[[Memory]] and `Memory` with [Memory](https://example.org).');
    expect(plain(result.body)).toBe(body);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining('REQUIRED RESPONSE FORMAT'), rejectTruncated: true,
    }));
  });
  it('keeps whitespace, citations and emphasis byte-for-byte', async () => {
    const body = '\n  **Memory** stores  facts.\\\nMemory fades. ⟦2⟧ (1, 2)\n\n';
    const result = await markChatTerms(body, new AbortController().signal, async () => json('Memory', '2', '1'));
    expect(plain(result.body)).toBe(body);
    expect(result.body).toContain('**[[Memory]]** stores  facts.\\\n[[Memory]] fades. ⟦2⟧ (1, 2)');
    expect(result.failed).toBe(0);
  });
  it.each([
    ['**Working memory**', '**[[Working memory]]**'],
    ['__Working memory__', '__[[Working memory]]__'],
    ['**Working** memory', '[[**Working** memory]]'],
    ['Working **memory**', '[[Working **memory**]]'],
    ['**Working** *memory*', '[[**Working** *memory*]]'],
    ['***Working memory***', '***[[Working memory]]***'],
    ['~~Working memory~~', '~~[[Working memory]]~~'],
    ['Working \n memory', '[[Working \n memory]]'],
  ])('handles emphasis and soft wrapping: %s', (body, expected) => {
    expect(select(body, 'Working memory')).toBe(expected);
  });
  it('preserves raw escapes, entities, punctuation and multilingual terms', () => {
    const body = 'R&amp;D, C++, C#, God-\\*image, pamięć robocza, 作業記憶は重要。';
    expect(select(body, 'R&D', 'C++', 'C#', 'God-*image', 'pamięć robocza', '作業記憶')).toBe(
      '[[R&amp;D]], [[C++]], [[C#]], [[God-\\*image]], [[pamięć robocza]], [[作業記憶]]は重要。');
  });
  it('handles tables, every bullet level, numbered titles, headings and quotes', () => {
    const body = '# Therapy\n\n- **Therapy**\n  - **therapist**: therapy.\n\n1. **Therapy**: therapy.\n\n> A therapist.\n\n| Therapy | Method |\n|:---|---:|\n| **therapy** | Exposure therapy |';
    const result = select(body, 'Therapy', 'therapy', 'therapist', 'Exposure therapy')!;
    expect(plain(result)).toBe(body);
    expect(result).toContain('- **[[Therapy]]**');
    expect(result).toContain('  - **[[therapist]]**: [[therapy]].');
    expect(result).toContain('1. **[[Therapy]]**: [[therapy]].');
    expect(result).toContain('> A [[therapist]].');
    expect(result).toContain('| **[[therapy]]** | [[Exposure therapy]] |');
  });
  it('protects code, links, images, HTML, citations, control tokens and existing terms', () => {
    const body = '[[memory]] memory memoryless `[[memory]]` [memory](https://example.org/memory) ![memory](memory.png)\n\n```txt\nmemory\n```\n\n<div>memory</div>\n\n⟦2⟧ ⟪E1⟫ (1,2)\n<<<SCATTER_PART_BREAK_abc>>>';
    expect(select(body, 'memory', '2', 'E1', 'SCATTER_PART_BREAK_abc')).toBe(body.replace(']] memory memoryless', ']] [[memory]] memoryless'));
    expect(stripTermMarkers(body)).toBe(body.replace('[[memory]] memory', 'memory memory'));
  });
  it('does not bridge a link, inline code, an image, a hard break or table cells', () => {
    for (const middle of ['[ignored](https://example.org)', '`ignored`', '![ignored](x.png)', '\\\n']) {
      const body = 'Working ' + middle + ' memory';
      expect(select(body, 'Working memory')).toBe(body);
    }
    const table = '|Working|memory|\n|---|---|\n|Working|memory|';
    expect(select(table, 'Working memory')).toBe(table);
  });
  it('prefers long phrases, repeats every eligible occurrence, and never nests', () => {
    expect(select('Working memory, memory, memoryless, [[memory]], Working memory.', 'memory', 'Working memory')).toBe(
      '[[Working memory]], [[memory]], memoryless, [[memory]], [[Working memory]].');
  });
  it('skips a phrase that would cut across only part of a bold span', () => {
    const body = '**Active working** memory matters.';
    expect(select(body, 'working memory')).toBe(body);
  });
  it('bounds concurrency, retries invalid JSON, and keeps successful batches', async () => {
    const body = ('Memory matters. '.repeat(200) + '\n\n').repeat(8);
    let active = 0, peak = 0, calls = 0;
    const complete = vi.fn(async () => {
      const index = calls++; active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1)); active--;
      return index < 2 ? 'An unwanted summary.' : json('Memory');
    });
    const result = await markChatTerms(body, new AbortController().signal, complete);
    expect(peak).toBeLessThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(chatTermBatches(body).length * 2);
    expect(plain(result.body)).toBe(body);
    expect(result.body).toContain('[[Memory]]');
  });
  it('never re-parses a split long link as markable prose', async () => {
    const body = '[' + 'Memory '.repeat(2000) + '](https://example.org)\n\nMemory.';
    const result = await markChatTerms(body, new AbortController().signal, async () => json('Memory'));
    expect(result.body).toBe(body.slice(0, -7) + '[[Memory]].');
  });
  it('retains original terms and text if both selection attempts fail', async () => {
    const body = '**[[Working memory]]**.\\\nNext line.';
    const complete = vi.fn(async () => 'Shortened text');
    expect(await markChatTerms(body, new AbortController().signal, complete)).toEqual({ body, failed: 1 });
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('accepts empty selections and ignores invented or unsafe terms without changing text', () => {
    expect(select('Memory matters.')).toBe('Memory matters.');
    expect(select('Memory matters.', 'Not in the answer', '[[Memory]]')).toBe('Memory matters.');
    expect(applyTermSelection('Memory', '{"terms":[42]}')).toBeNull();
  });
  it('keeps generous rules, a worked example, and the JSON contract even with old custom prompts', () => {
    const prompt = termSelectionPrompt('ACTUAL INPUT');
    expect(prompt.system).toContain('Be generous; when in doubt, mark it');
    expect(prompt.system).toContain('not just advanced jargon');
    expect(prompt.system).toContain('A [[therapist]] can treat someone with [[anxiety]]');
    expect(prompt.system).toContain('can write [[code]]');
    expect(prompt.system).toContain('[[**Exposure** therapy]]');
    expect(prompt.user).toBe('ACTUAL INPUT');
    const custom = termSelectionPrompt('Memory', { chipBase: 'Copy the answer.', taskAddChips: 'Mark every term. {plainBody}' });
    expect(custom.system).toContain('Mark every term.');
    expect(custom.system).toContain('overrides any earlier instructions to copy text');
    expect(custom.user).toBe('Memory');
  });
});
