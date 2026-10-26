import type { ProviderPreset } from '@/store/types';

export function providerLabel(preset: ProviderPreset, name?: string): string {
  if ((preset === 'ollama' || preset === 'lm-studio' || preset === 'custom') && name?.trim()) return name.trim();
  return {
    gemini: 'Google Gemini',
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    ollama: 'Ollama',
    'lm-studio': 'LM Studio',
    custom: 'OpenAI-compatible',
  }[preset];
}
