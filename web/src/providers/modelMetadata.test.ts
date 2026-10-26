import { describe, expect, it } from 'vitest';
import { parseCompatModel } from './openai';
import { compatibleMetadata } from './modelMetadata';
import { reasoningLevels, effectiveReasoningEffort } from '@/lib/modelReasoning';
import { validServerSearch, supportsModelSearch } from './modelSearch';

describe('generic server metadata', () => {
  it('preserves unknown capabilities, rather than inventing support from a name', () => {
    expect(parseCompatModel({ id: 'vision-thinking-tools' }).caps).toBeUndefined();
    expect(compatibleMetadata({ capabilities: ['vision'] })).toEqual({ caps: { vision: true } });
  });
  it('reads boolean aliases, numeric strings, modalities and server reasoning options', () => {
    const info = parseCompatModel({ id: 'local', capabilities: { vision: true, trained_for_tool_use: true, reasoning: { allowed_options: ['off', 'on'], default: 'on' } },
      max_model_len: '32768', max_completion_tokens: '8192', output_modalities: ['text'] });
    expect(info).toMatchObject({ contextLength: 32768, maxOutputTokens: 8192, caps: { vision: true, tools: true, textOutput: true, reasoning: true },
      reasoning: { mode: 'toggle', supportedEfforts: ['off', 'high'], defaultEffort: 'high' } });
  });
  it('does not invent reasoning levels when the server only reports the capability', () => {
    for (const metadata of [{ supports_reasoning: true }, { reasoning: { allowed_options: ['future-level'] } }]) {
      const info = parseCompatModel({ id: 'local', ...metadata });
      expect(info.caps?.reasoning).toBe(true);
      expect(reasoningLevels('custom', 'local', info)).toEqual([]);
      expect(effectiveReasoningEffort('custom', 'local', 'high', info)).toBeUndefined();
    }
  });
  it('respects explicit negative capabilities', () => {
    expect(parseCompatModel({ id: 'local', capabilities: { vision: false, tools: false } }).caps).toMatchObject({ vision: false, tools: false });
  });
  it('allows bypass with a configured search service, but still requires search infrastructure', () => {
    const config = { kind: 'lmstudio-mcp' as const, server: 'web-search', tools: ['searxng_web_search'] };
    expect(validServerSearch(config)).toBe(true);
    expect(supportsModelSearch('lm-studio', 'local', undefined, undefined, config)).toBe(false);
    expect(supportsModelSearch('lm-studio', 'local', undefined, undefined, config, true)).toBe(true);
    expect(supportsModelSearch('lm-studio', 'local', undefined, undefined, undefined, true)).toBe(false);
    // LM Studio's empty field uses the displayed default tool name.
    expect(validServerSearch({ ...config, tools: [] })).toBe(true);
    expect(validServerSearch({ ...config, server: '', tools: [] })).toBe(false);
  });
});
