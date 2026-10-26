/** Opt-in paid evaluation; never makes network calls during the normal suite.
 * SCATTER_PREVIEW_EVAL=1 npx vitest run src/lib/termPreviews.live.test.ts */
import { it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { TERM_PREVIEW_SYSTEM, termPreviewUser } from './termPreviewPrompt';
import { DEFAULT_PROMPTS, substitute } from './promptDefaults';
import { markTerms } from './termMarking';
import { previewTerms, completeTermPreviews } from './termPreviewCore';
import type { NodeVersion } from '@/store/types';

const fixtures = [
  { header: 'Operating systems', terms: ['operating system', 'kernel', 'process', 'thread', 'scheduler', 'context switch', 'virtual memory', 'page', 'page fault', 'file system', 'directory', 'inode', 'system call', 'device driver', 'interrupt', 'buffer', 'cache', 'deadlock', 'semaphore', 'mutex', 'permissions', 'shell', 'code', 'compiler'],
    context: 'An operating system manages hardware resources and provides services to applications. The kernel controls processes and threads, with a scheduler choosing what runs next through context switches. Virtual memory maps pages to physical RAM; a page fault requests a missing page. File systems organize directories and inodes. Applications use system calls; device drivers handle interrupts. Buffers hold data in transit while caches retain reusable data. Mutexes and semaphores coordinate concurrent work, which can deadlock. Permissions control access. A shell interprets commands; a compiler translates source code into another form.' },
  { header: 'Learning and psychotherapy', terms: ['therapy', 'therapist', 'psychotherapy', 'cognitive behavioral therapy', 'anxiety', 'phobia', 'exposure therapy', 'habituation', 'extinction', 'inhibitory learning', 'conditioning', 'reinforcement', 'negative reinforcement', 'avoidance', 'safety behavior', 'stimulus', 'response', 'working memory', 'cognitive bias', 'rumination', 'mindfulness', 'assessment', 'diagnosis', 'randomized controlled trial'],
    context: 'Psychotherapy uses psychological methods to address distress and change patterns of thought and behavior. Cognitive behavioral therapy can help with anxiety and phobias. A therapist assesses the person and plans therapy; assessment and diagnosis are related but distinct. Exposure therapy reduces avoidance and safety behaviors through planned encounters with feared stimuli. Habituation, extinction and inhibitory learning describe different changes in responding. Conditioning links stimuli and responses; reinforcement changes behavior, with negative reinforcement removing something unpleasant. Working memory holds information for current tasks. Cognitive biases and rumination influence attention and beliefs; mindfulness practices present-focused awareness. Randomized controlled trials test treatments by assigning participants to groups by chance.' },
];

it.skipIf(process.env.SCATTER_PREVIEW_EVAL !== '1')('compares live Luna grouping strategies', async () => {
  const key = (await readFile('../.agents/skills/openrouter-test/openrouter.key', 'utf8')).trim();
  const results: unknown[] = [];
  for (const fixture of fixtures) for (const size of [24, 8, 1]) {
    const groups = Array.from({ length: Math.ceil(fixture.terms.length / size) }, (_, i) =>
      fixture.terms.slice(i * size, (i + 1) * size).map((term, j) => ({ id: i * size + j, term })));
    const started = Date.now();
    let cursor = 0;
    const calls: any[] = [];
    await Promise.all(Array.from({ length: Math.min(3, groups.length) }, async () => {
      while (cursor < groups.length) {
        const terms = groups[cursor++]!;
        const time = Date.now();
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'openai/gpt-5.6-luna', reasoning: { effort: 'low', exclude: true },
            max_tokens: Math.max(1200, terms.length * 160),
            messages: [{ role: 'system', content: TERM_PREVIEW_SYSTEM },
              { role: 'user', content: termPreviewUser(fixture.header, fixture.context, terms) }] }),
          signal: AbortSignal.timeout(120_000),
        });
        const data: any = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(data.error));
        const raw = data.choices?.[0]?.message?.content ?? '';
        let parsed: any;
        try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch {}
        calls.push({ terms, ms: Date.now() - time, usage: data.usage, finish: data.choices?.[0]?.finish_reason,
          raw, coverage: terms.filter(t => parsed?.previews?.some((p: any) => p.id === t.id)).length,
          formatted: parsed?.previews?.filter((p: any) => [5, 7].includes(p.parts?.length)).length ?? 0 });
      }
    }));
    const result = { topic: fixture.header, size, ms: Date.now() - started,
      input: calls.reduce((s, c) => s + (c.usage?.prompt_tokens ?? 0), 0),
      output: calls.reduce((s, c) => s + (c.usage?.completion_tokens ?? 0), 0),
      cost: calls.reduce((s, c) => s + (c.usage?.cost ?? 0), 0),
      coverage: calls.reduce((s, c) => s + c.coverage, 0), formatted: calls.reduce((s, c) => s + c.formatted, 0), calls };
    results.push(result);
    console.log(JSON.stringify({ ...result, calls: undefined }));
    await writeFile('/tmp/scatter-term-preview-eval-parts.json', JSON.stringify(results, null, 2));
    expect(result.coverage).toBe(fixture.terms.length);
  }
}, 600_000);

it.skipIf(process.env.SCATTER_PREVIEW_STANDARD !== '1')('measures a standard generated encyclopedia node', async () => {
  const key = (await readFile('../.agents/skills/openrouter-test/openrouter.key', 'utf8')).trim();
  const calls: any[] = [];
  let stage = 'node';
  const call = async (options: { system: string; user: string; maxOutputTokens?: number }) => {
    const started = Date.now();
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-5.6-luna', reasoning: { effort: 'low', exclude: true },
        max_tokens: options.maxOutputTokens ?? 8000,
        messages: [{ role: 'system', content: options.system }, { role: 'user', content: options.user }] }),
      signal: AbortSignal.timeout(120_000),
    });
    const data: any = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data.error));
    const text = data.choices?.[0]?.message?.content ?? '';
    calls.push({ stage, usage: data.usage, ms: Date.now() - started, finish: data.choices?.[0]?.finish_reason, text });
    return text;
  };
  const cached = process.env.SCATTER_PREVIEW_REUSE === '1'
    ? JSON.parse(await readFile('/tmp/scatter-term-preview-standard.json', 'utf8')) : undefined;
  const body = cached?.body ?? await call({ system: substitute(DEFAULT_PROMPTS.base, { maxLevel1: '10' }),
    user: substitute(DEFAULT_PROMPTS.taskRoot, { topic: 'Operating systems' }) });
  stage = 'marking';
  const marked = cached ? { body: cached.marked } : await markTerms(body, AbortSignal.timeout(180_000), call);
  const v: NodeVersion = { header: 'Operating systems', body: marked.body, createdAt: 1, generatedBy: 'root', contentType: 'encyclopedic' };
  const terms = previewTerms(v);
  stage = 'previews';
  const entries: Record<string, string> = {};
  const failed = await completeTermPreviews(v, terms, call, result => Object.assign(entries, result));
  const accepted = Object.keys(entries).length;
  await writeFile(cached ? '/tmp/scatter-term-preview-standard-focused.json' : '/tmp/scatter-term-preview-standard.json', JSON.stringify({ body, marked: marked.body, terms, accepted, failed, calls }, null, 2));
  expect(failed).toEqual([]);
  expect(accepted).toBe(terms.length);
}, 600_000);
