import { expect, it } from 'vitest';
import { normalizeProviderError, streamProviderError } from './errors';

const router = 'https://openrouter.ai/api/v1';
it.each([
  [402, 'openrouter_credits', 'Manage credits', false],
  [402, 'openrouter_key_limit', 'Manage spending limit', false],
  [403, 'openrouter_guardrail_budget', 'workspace administrator', false],
  [429, 'openrouter_workspace_budget', 'workspace administrator', false],
  [402, 'openrouter_in_flight_budget', 'settle', true],
] as const)('explains OpenRouter %s / %s, including inside a successful stream', (status, limit_source, hint, retryable) => {
  const error = {code: status, message: 'Provider error', metadata: {limit_source}};
  for (const e of [normalizeProviderError(status, JSON.stringify({error}), '15', router), streamProviderError(error, router, '')]) {
    expect(e.message).toContain(hint); expect(e.retryable).toBe(retryable);
    expect(e.kind).toBe(retryable ? 'rate_limit' : 'insufficient_credits');
  }
});
it.each([
  ['api.openai.com', 429, {code: 'insufficient_quota'}, 'OpenAI Platform'],
  ['api.openai.com', 429, {code: 'project_spend_limit_exceeded'}, 'project limits'],
  ['api.anthropic.com', 400, {type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.'}, 'Claude Console'],
  ['api.anthropic.com', 429, {type: 'rate_limit_error', details: {error_code: 'enforced_spend_limit_reached'}}, 'workspace limits'],
  ['api.anthropic.com', 402, {type: 'billing_error'}, 'payment details'],
  ['local.example', 402, {}, 'server administrator'],
] as const)('%s gives a billing remedy for %s', (host, status, error, hint) => {
  const e = normalizeProviderError(status, JSON.stringify({error}), undefined, 'https://' + host);
  expect(e).toMatchObject({kind: 'insufficient_credits', retryable: false});
  expect(e.message).toContain(hint);
});
it('keeps ordinary rate and authentication failures separate from billing', () => {
  expect(normalizeProviderError(429, '{"error":{"code":"rate_limit_exceeded"}}', '5', router)).toMatchObject({kind: 'rate_limit', retryAfterMs: 5000});
  expect(normalizeProviderError(401, 'insufficient credits', undefined, router).kind).toBe('auth');
  expect(streamProviderError({code: '402', message: 'Payment required'}, router, '').kind).toBe('insufficient_credits');
  expect(normalizeProviderError(402, '', undefined, 'https://openrouter.ai.example').message).not.toContain('OpenRouter');
  expect(streamProviderError({type: 'invalid_request_error', message: 'Bad schema'}, 'https://api.anthropic.com', '')).toMatchObject({kind: 'bad_request', retryable: false});
  expect(streamProviderError({type: 'rate_limit_error'}, 'https://api.anthropic.com', '')).toMatchObject({kind: 'rate_limit'});
});
