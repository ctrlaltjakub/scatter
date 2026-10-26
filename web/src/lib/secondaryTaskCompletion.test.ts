import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { getAdapter } from '@/providers/registry';
import { secondaryTaskCompletion } from './secondaryTaskCompletion';
import { GenerationOutputLimitError } from './generationLimits';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(), loadSettings: vi.fn() }));
beforeEach(() => useSettingsStore.setState({ ...DEFAULT_SETTINGS, providers: [{ id: 's', preset: 'custom', apiKey: 'fixture', enabledModels: ['model'] }], activeModelRef: { providerId: 's', model: 'model' }, secondaryModelRef: undefined }));
afterEach(() => vi.restoreAllMocks());
describe('secondary task allowances', () => {
  it('never bills embedded image bytes as text and restores references in edited output', async () => {
    const body = '![Example](data:image/png;base64,' + 'abcd'.repeat(5000) + ')';
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, opts) {
      const user = opts.messages.find(message => message.role === 'user')!.content;
      expect(user).not.toContain('base64');
      expect(user.length).toBeLessThan(100);
      yield { delta: user, done: true };
    });
    expect(await secondaryTaskCompletion({ system: 'Keep the image', user: body })).toBe(body);
  });
  it('scales actual provider requests, keeping low reasoning', async () => {
    useSettingsStore.getState().setGenerationTokenLimit('secondaryOutputTokenCap', 24000);
    const spy = vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* (_key, opts) {
      expect(opts.maxOutputTokens).toBe(512);
      expect(opts.reasoningEffort).toBe('low');
      yield { delta: 'Title', done: true };
    });
    expect(await secondaryTaskCompletion({ system: 'system', user: 'task', maxOutputTokens: 256 })).toBe('Title');
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it.each(['length', 'max_tokens'])('rejects %s rather than accepting truncated data', async finishReason => {
    vi.spyOn(getAdapter('custom'), 'streamChat').mockImplementation(async function* () { yield { delta: 'partial', done: true, finishReason }; });
    await expect(secondaryTaskCompletion({ system: 'system', user: 'task' })).rejects.toBeInstanceOf(GenerationOutputLimitError);
  });
});
