/** Explicit opt-in paid regression; ordinary test runs never call a provider. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openrouterAdapter } from '@/providers/openrouter';
import { plain } from '@/lib/chipReveal';
import { markChatTerms, chatTermBatches } from './termMarking';

describe.skipIf(process.env.SCATTER_REAL_TERM_SMOKE !== '1')('real long chat term marking', () => {
  it('preserves varied Markdown in a long answer', async () => {
    const path = ['../.agents/skills/openrouter-test/openrouter.key', '../.Codex/skills/openrouter-test/openrouter.key']
      .map((file) => resolve(file)).find(existsSync);
    if (!path) throw new Error('The approved OpenRouter test key is unavailable.');
    const key = readFileSync(path, 'utf8').trim();
    const body = Array.from({ length: 5 }, (_, index) => [
      `### Comparing memory systems: study ${index + 1}`,
      '**Working memory** holds  information briefly, whereas *episodic memory* preserves personal events.  \nThe **hippocampus** supports consolidation. ⟦1⟧',
      '|System|Duration|Mechanism|\n|:---|---:|:---:|\n|Working memory|Seconds|Active maintenance; **attention** controls access.|\n|Episodic memory|Years|**Consolidation** stabilizes representations. Retrieval reconstructs events.|',
      '1. **Encoding** transforms sensory input into a usable representation.\n    - Selective attention filters competing information.\n    - Elaborative rehearsal connects new facts to existing knowledge.\n2. **Retrieval** depends on cues and context.',
      '> **Baddeley and Hitch** proposed multiple components.\n> The phonological loop handles verbal material.\n>\n> The visuospatial sketchpad handles spatial material.',
      'In Japanese: **作業記憶**は短時間の情報保持を支える。\nPo polsku: **pamięć epizodyczna** wiąże zdarzenia z kontekstem.',
      'An escaped symbol: \\* is not emphasis. A literal `[[memory]]` is code, not a term. [Read the study](https://example.org/memory?year=1974&part=2).',
    ].join('\n\n')).join('\n\n');
    let calls = 0;
    const result = await markChatTerms(body, AbortSignal.timeout(120_000), async (options) => {
      calls++; let output = '';
      for await (const chunk of openrouterAdapter.streamChat(key, {
        model: 'google/gemini-3.5-flash', messages: [{ role: 'system', content: options.system }, { role: 'user', content: options.user }],
        maxOutputTokens: options.maxOutputTokens ?? 6000, reasoningEffort: 'low', webSearch: false, signal: options.signal,
      })) output += chunk.delta;
      return output;
    });
    process.stdout.write(`Varied Markdown: ${JSON.stringify({ inputCharacters: body.length, calls, failures: result.failed, terms: (result.body.match(/\[\[/g) ?? []).length })}\n`);
    expect(plain(result.body)).toBe(plain(body));
    expect(result.body).toContain('`[[memory]]`');
    expect(result.failed).toBe(0);
    expect(result.body).toContain('[[Working memory]]');
  }, 130_000);

  it('uses real term selection on the first attempt, including basic concepts', async () => {
    const path = ['../.agents/skills/openrouter-test/openrouter.key', '../.Codex/skills/openrouter-test/openrouter.key']
      .map((file) => resolve(file)).find(existsSync);
    if (!path) throw new Error('The approved OpenRouter test key is unavailable.');
    const key = readFileSync(path, 'utf8').trim();
    const body = '## Getting help and building things\n\nA therapist can treat someone with anxiety. They write notes after therapy.\n\n- **Software development**\n  - A programmer can write code in Python. An algorithm describes the steps.\n\n| Method | What it does |\n|---|---|\n| **Cognitive** behavioral therapy | Helps examine beliefs |\n| Compiler | Translates code |';
    let calls = 0;
    const result = await markChatTerms(body, AbortSignal.timeout(120_000), async (options) => {
      calls++;
      let output = '';
      for await (const chunk of openrouterAdapter.streamChat(key, {
        model: 'google/gemini-3.5-flash', messages: [{ role: 'system', content: options.system }, { role: 'user', content: options.user }],
        maxOutputTokens: options.maxOutputTokens ?? 6000, reasoningEffort: 'low', webSearch: false, signal: options.signal,
      })) output += chunk.delta;
      process.stdout.write(`Basic-concept selection: ${output}\n`);
      expect(() => JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))).not.toThrow();
      return output;
    });
    expect(calls).toBe(1);
    expect(result.failed).toBe(0);
    expect(plain(result.body)).toBe(body);
    for (const term of ['therapist', 'therapy', 'code', 'programmer', 'Python', 'algorithm', 'Compiler']) {
      expect(result.body).toContain(`[[${term}]]`);
    }
    for (const word of ['write', 'treat someone', 'notes', 'someone']) expect(result.body).not.toContain(`[[${word}]]`);
    expect(result.body).toContain('[[**Cognitive** behavioral therapy]]');
  }, 130_000);

  it('marks a long answer in bounded requests without damaging its Markdown', async () => {
    const path = ['../.agents/skills/openrouter-test/openrouter.key', '../.Codex/skills/openrouter-test/openrouter.key']
      .map((file) => resolve(file)).find(existsSync);
    if (!path) throw new Error('The approved OpenRouter test key is unavailable.');
    const key = readFileSync(path, 'utf8').trim();
    const body = Array.from({ length: 14 }, (_, index) => `## Memory study ${index + 1}\n\n**Working memory** holds **limited information** for a current task. Cognitive psychologists study attention, rehearsal, and retrieval through carefully designed experiments. Baddeley and Hitch proposed a model involving a central executive, a phonological loop, and a visuospatial sketchpad.\n\n- **Episodic memory** concerns events and their context.\n- Semantic memory supports knowledge of concepts and facts. ⟦1⟧\n\nA line about the **hippocampus**.\\\nA separate line about **neuroplasticity**.\n\n`).join('');
    let calls = 0;
    const result = await markChatTerms(body, AbortSignal.timeout(120_000), async (options) => {
      calls++; let output = '';
      for await (const chunk of openrouterAdapter.streamChat(key, {
        model: 'google/gemini-3.5-flash', messages: [{ role: 'system', content: options.system }, { role: 'user', content: options.user }],
        maxOutputTokens: options.maxOutputTokens ?? 6000, reasoningEffort: 'low', webSearch: false, signal: options.signal,
      })) output += chunk.delta;
      return output;
    });
    process.stdout.write(`Term marking: ${JSON.stringify({ inputCharacters: body.length, batches: chatTermBatches(body).filter((b) => !b.skip && b.text.trim()).length, calls, failures: result.failed, terms: (result.body.match(/\[\[/g) ?? []).length })}\n`);
    expect(plain(result.body)).toBe(body);
    expect(result.failed).toBe(0);
    expect((result.body.match(/\[\[/g) ?? []).length).toBeGreaterThan(80);
    expect(calls).toBe(chatTermBatches(body).filter((batch) => !batch.skip && batch.text.trim()).length);
  }, 130_000);
});
