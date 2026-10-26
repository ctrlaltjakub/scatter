import { describe, expect, it } from 'vitest';
import { mainModelCompatible } from '../modelMeta';
import { chatModelCompatible } from './availability';

describe('saved chat model compatibility', () => {
  it('keeps an existing local chat usable without weakening model-picker eligibility', () => {
    const info = { id: 'local', caps: { vision: true, tools: true, textOutput: true } };
    expect(mainModelCompatible('custom', 'local', info)).toBe(false);
    expect(chatModelCompatible('custom', 'local', info)).toBe(true);
    expect(chatModelCompatible('custom', 'local', { id: 'local', caps: { vision: false, tools: true } })).toBe(false);
    expect(chatModelCompatible('custom', 'local', { id: 'local', caps: { vision: true, tools: false } })).toBe(false);
  });
});
