import { GenerationOutputLimitError, isOutputLimit } from './generationLimits';
import { isValidStructure } from './bulletParse';
import { friendlyErrorMessage, ProviderError } from '@/providers/errors';

export type ResponseProblem = 'empty_output' | 'invalid_structure' | 'invalid_json' | 'tool_call' | 'interrupted' | 'refused' | 'wrong_result';
export class GenerationResponseError extends Error {
  constructor(public code: ResponseProblem, message: string, public remedy: string) {
    super(`${message} ${remedy}`); this.name = 'GenerationResponseError';
  }
}
export function checkFinishReason(reason: string | null | undefined, role: 'main' | 'secondary' | 'interactive'): void {
  if (isOutputLimit(reason)) throw new GenerationOutputLimitError(role);
  if (['content_filter', 'safety', 'refusal', 'prohibited_content'].includes(reason ?? '')) {
    throw new GenerationResponseError('refused', 'The provider blocked this response.', 'Rephrase the request or check the provider’s content policy.');
  }
  if (reason === 'incomplete') throw new GenerationResponseError('interrupted', 'The provider ended the response before it was complete.', 'Check the connection and retry.');
}
export function requireVisibleText(text: string, role: 'main' | 'secondary' | 'interactive' = 'main'): void {
  if (!text.trim()) throw new GenerationResponseError('empty_output', `The ${role} model returned no answer text.`,
    'Retry once. If this repeats, lower reasoning effort, increase the generation token limit, or choose a text-generation model.');
}
export function validateEncyclopedicOutput(text: string): void {
  if (!isValidStructure(text)) throw new GenerationResponseError('invalid_structure',
    'The response does not have the required two-level encyclopedic outline (at least two sections, each with two subpoints).',
    'Retry once; if it repeats, restore the relevant system prompts or choose a model with stronger structured output.');
}
export function parseResponseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new GenerationResponseError('invalid_json', 'The model returned invalid JSON instead of the required object.',
    'Retry once. If this repeats, restore the relevant system prompt or use a model with reliable structured output.'); }
}
export function diagnosticError(error: unknown): { status: 'failed' | 'inconclusive'; code: string; detail: string } {
  // Acceptance gates wrap provider/reviewer errors to prevent pointless code
  // repairs. Keep the original diagnostic category (limits, network, etc.).
  if (error instanceof Error && error.name === 'InteractiveVerificationError' && error.cause instanceof Error && error.cause !== error) {
    const original = diagnosticError(error.cause);
    return { ...original, detail: error.message };
  }
  const message = friendlyErrorMessage(error);
  if ((error as Error)?.name === 'TimeoutError' || /timed? ?out|timeout/i.test(message)) return {
    status: 'inconclusive', code: 'timeout', detail: 'The test timed out. This does not prove the capability is unsupported. Load the model first, reduce server load, or increase the test timeout and run it again.',
  };
  if (error instanceof GenerationOutputLimitError) return { status: 'failed', code: 'output_limit', detail: error.message };
  if (error instanceof GenerationResponseError) return { status: 'failed', code: error.code, detail: error.message };
  if (error instanceof ProviderError) return { status: ['network', 'server', 'rate_limit'].includes(error.kind) ? 'inconclusive' : 'failed', code: error.kind, detail: error.message };
  if (/fetch|network|connection/i.test(message)) return { status: 'inconclusive', code: 'connection', detail: `${message} Check the server URL, CORS, authentication, and browser local-network permissions.` };
  return { status: 'failed', code: /tool/i.test(message) ? 'tool_call' : 'response', detail: `${message} Retry once; if it repeats, check the model and system prompts.` };
}
