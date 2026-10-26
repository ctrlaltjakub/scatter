/** Opt-in, one small paid call through the actual chat-image/provider adapters. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { loadAsset } from '@/opfs/assetsIO';
import { openrouterAdapter } from '@/providers/openrouter';
import { chatImageInput } from './imageInput';

vi.mock('@/opfs/assetsIO', () => ({ loadAsset: vi.fn() }));
describe.skipIf(process.env.SCATTER_REAL_IMAGE_SMOKE !== '1')('real stored chat image', () => {
  it('recognizes pixels after the storage layer has discarded the MIME type', async () => {
    const keyPath = ['../.agents/skills/openrouter-test/openrouter.key', '../.Codex/skills/openrouter-test/openrouter.key']
      .map((file) => resolve(file)).find(existsSync);
    if (!keyPath) throw new Error('The approved OpenRouter test key is unavailable.');
    const key = readFileSync(keyPath, 'utf8').trim();
    const model = 'google/gemini-3.5-flash';
    expect((await openrouterAdapter.listModels(key)).some((item) => item.id === model)).toBe(true);
    const bytes = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="white"/><circle cx="80" cy="90" r="48" fill="#f00000"/><rect x="194" y="42" width="96" height="96" fill="#0000ee"/></svg>')).png().toBuffer();
    vi.mocked(loadAsset).mockResolvedValueOnce(new Blob([new Uint8Array(bytes)]));
    const url = await chatImageInput('fixture', { kind: 'image', source: 'asset', assetId: 'sample', mime: 'image/png' });
    expect(url).toMatch(/^data:image\/png;base64,/);
    let answer = '';
    for await (const chunk of openrouterAdapter.streamChat(key, { model,
      messages: [], conversation: [{ role: 'user', content: 'Name the two shapes and their colors, from left to right. Keep the answer under 30 words.',
        images: [{ id: 'sample', url: url!, detail: 'high' }] }],
      maxOutputTokens: 1000, reasoningEffort: 'low', webSearch: false, signal: AbortSignal.timeout(90_000),
    })) answer += chunk.delta;
    process.stdout.write(`Stored-image vision result: ${answer}\n`);
    expect(answer.toLowerCase()).toMatch(/red[\s\S]*circle/);
    expect(answer.toLowerCase()).toMatch(/blue[\s\S]*square/);
    expect(answer).not.toMatch(/inaccessible|binary data|IDAT|unrendered/i);
  }, 100_000);
});
