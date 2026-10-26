// @vitest-environment node
/** Opt-in real Image API multipart check. Node environment uses real Blob/FormData. */
import { it, expect } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openaiImageAdapter } from './images';

it.skipIf(process.env.SCATTER_IMAGE_AUDIT !== 'openai' && !process.env.SCATTER_IMAGE_EDIT_INPUT)('generates and edits images through the direct OpenAI adapter', async () => {
  const root = process.env.SCATTER_PROVIDER_TEST_DIR ?? join(homedir(), '.local/share/scatter-provider-tests/2026-10-12');
  const secrets = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'));
  const directory = join(root, 'results', `openai-image-api-${Date.now()}`);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const source = process.env.SCATTER_IMAGE_EDIT_INPUT ? await readFile(process.env.SCATTER_IMAGE_EDIT_INPUT) : (await openaiImageAdapter.generate(secrets.openai, {
    model: 'gpt-image-2.5-sunburst', prompt: 'Educational diagram on white background: one red triangle on the left and one blue circle on the right. Flat solid shapes. No text.',
    size: '1024x1024', quality: 'low', signal: AbortSignal.timeout(120000),
  })).bytes;
  await writeFile(join(directory, 'original.png'), source);
  const result = await openaiImageAdapter.edit!(secrets.openai, {
    model: 'gpt-image-2.5-sunburst', image: new Blob([source as BlobPart], { type: 'image/png' }),
    prompt: 'Change only the red triangle to green. Preserve the blue circle, white background, arrangement and proportions.',
    size: '1024x1024', quality: 'low', signal: AbortSignal.timeout(120000),
  });
  expect(result.bytes.length).toBeGreaterThan(100);
  await writeFile(join(directory, 'edited.png'), result.bytes);
  await writeFile(join(directory, 'result.json'), JSON.stringify({status:'pass',mime:result.mime,bytes:result.bytes.length,generated:!process.env.SCATTER_IMAGE_EDIT_INPUT}));
}, 250000);
