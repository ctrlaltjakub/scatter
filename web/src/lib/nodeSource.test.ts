import { beforeEach, expect, it, vi } from 'vitest';
import { nodeSourceSnapshot, addNodeVersionToSources } from './nodeSource';
import { LANGUAGES } from './languages';
import type { NodeVersion } from '@/store/types';
import { addPastedSource, waitForProjectSources } from './sourceProcessing';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';

vi.mock('./sourceProcessing', () => ({ addPastedSource: vi.fn(async () => 'job'), waitForProjectSources: vi.fn(async () => {}) }));
const version = (body: string): NodeVersion => ({ header: 'A [[topic]]', body, createdAt: 1, generatedBy: 'manual',
  sources: [{ n: 3, url: 'https://example.org/facts', title: 'Source', domain: 'example.org' }] });
beforeEach(() => { vi.clearAllMocks(); useSourceRuntimeStore.setState({ jobs: {} }); });

it.each(LANGUAGES)('preserves $name and bibliography while stripping term markup', language => {
  const result = nodeSourceSnapshot({ ...version(`**[[${language.sample}]]** ⟦3⟧`), language: language.id });
  expect(result.title).toBe('A topic');
  expect(result.text).toContain(language.sample);
  expect(result.text).not.toContain('[[');
  expect(result.text).toContain('⟦3⟧');
  expect(result.text).toContain('⟦3⟧ [example.org](https://example.org/facts)');
});
it('preserves Markdown tables, code and mixed emphasis without merging bold delimiters', () => {
  const result = nodeSourceSnapshot(version('**Before [[marked]] after**\n\n| Name | Value |\n|---|---|\n| [[日本語]] | العربية |\n\n```js\nconst array = [[1]];\n```'));
  expect(result.text).toContain('**Before marked after**');
  expect(result.text).toContain('日本語'); expect(result.text).toContain('العربية');
  expect(result.text).toContain('const array = [[1]];');
  expect(result.text).toContain('|');
});
it('uses the edited header of a copied answer or Markdown note, not its old chat title', () => {
  const copy = { ...version('Copied text'), contentType: 'answer', header: 'Renamed node', chat: { title: 'Old answer title' } } as NodeVersion;
  expect(nodeSourceSnapshot(copy).title).toBe('Renamed node');
});
it('copies only one answer, never its paired question, and keeps internal source URLs', () => {
  const answer = { ...version('Only [[this answer]]⟦3⟧ (1).'), chat: { title: 'Answer title', question: 'Private paired question' },
    internalSources: [{ n: 1, sourceId: 's', sourceTitle: 'Uploaded source', originalUrl: 'https://example.org/original', excerpt: 'Quoted passage' }] } as NodeVersion;
  const result = nodeSourceSnapshot(answer);
  expect(result.title).toBe('Answer title'); expect(result.text).not.toContain('Private paired question');
  expect(result.text).toContain('Only this answer'); expect(result.text).toContain('https://example.org/original');
  expect(result.text).toContain('Quoted passage');
});
it('captures project and content before asynchronous import and reports processing failures', async () => {
  const original = version('Original [[text]]⟦3⟧');
  const promise = addNodeVersionToSources('original-project', original);
  original.body = 'Changed';
  await promise;
  expect(addPastedSource).toHaveBeenCalledWith('original-project', 'A topic', expect.stringContaining('Original text'));
  expect(waitForProjectSources).toHaveBeenCalledWith('original-project', ['job']);
  useSourceRuntimeStore.setState({ jobs: { job: { status: 'failed', error: 'Indexing failed' } as never } });
  await expect(addNodeVersionToSources('p', original)).rejects.toThrow('Open Sources to retry');
});
