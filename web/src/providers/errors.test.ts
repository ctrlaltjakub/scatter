import { describe, expect, test } from 'vitest';
import { normalizeProviderError, friendlyErrorMessage, ProviderError } from './errors';

describe('normalizeProviderError', () => {
  test('separates an excessive output allowance from an input context error', () => {
    const output = normalizeProviderError(400, JSON.stringify({ error: { message: 'max_tokens must be at most 8192' } }));
    expect(output.kind).toBe('output_limit');
    expect(output.message).toContain('Lower it in Settings → Models and generation → Generation token limits');
    const context = normalizeProviderError(400, JSON.stringify({ error: { message: 'max_tokens exceeds the remaining context after input tokens' } }));
    expect(context.kind).toBe('context');
    const tooSmall = normalizeProviderError(400, JSON.stringify({ error: { message: 'max_tokens must be greater than 1024' } }));
    expect(tooSmall.kind).toBe('bad_request');
    expect(tooSmall.message).not.toContain('Lower it');
  });
  test('401/403 → auth', () => {
    const e = normalizeProviderError(401, '{"error":{"message":"invalid key"}}');
    expect(e.kind).toBe('auth');
    expect(e.message).toMatch(/key was rejected/i);
    expect(e.retryable).toBe(false);
  });
  test('429 → rate_limit, retryable', () => {
    const e = normalizeProviderError(429, '');
    expect(e.kind).toBe('rate_limit');
    expect(e.retryable).toBe(true);
  });
  test('429 exhausted billing quota is not a retryable rate limit', () => {
    const error = normalizeProviderError(429, JSON.stringify({ error: {
      code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.',
    } }));
    expect(error.kind).toBe('insufficient_credits');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('project budget');
  });
  test('402 → insufficient_credits', () => {
    expect(normalizeProviderError(402, '').kind).toBe('insufficient_credits');
  });
  test('400 with a context message → context', () => {
    const e = normalizeProviderError(400, '{"error":{"message":"maximum context length exceeded"}}');
    expect(e.kind).toBe('context');
    expect(e.message).toContain('input and requested output allowance');
    expect(e.message).toContain('Lower the token limit');
    expect(e.message).toContain('Search results and tool instructions');
  });
  test('400 otherwise → bad_request, includes provider detail', () => {
    const e = normalizeProviderError(400, '{"error":{"message":"bad model id"}}');
    expect(e.kind).toBe('bad_request');
    expect(e.message).toMatch(/bad model id/);
  });
  test('a schema location called context is not a context-length error', () => {
    const e = normalizeProviderError(400, JSON.stringify({ error: {
      message: "Invalid schema for function 'check_document': In context=('properties', 'actions', 'items'), missing required field 'value'.",
      code: 'invalid_function_parameters',
    } }));
    expect(e.kind).toBe('bad_request');
    expect(e.message).toContain('Invalid schema');
  });
  test('5xx → server, retryable', () => {
    const e = normalizeProviderError(503, '');
    expect(e.kind).toBe('server');
    expect(e.retryable).toBe(true);
  });
  test('no status → network', () => {
    expect(normalizeProviderError(undefined, '').kind).toBe('network');
  });
});

describe('friendlyErrorMessage', () => {
  test('passes a ProviderError message through', () => {
    expect(friendlyErrorMessage(new ProviderError('x', { kind: 'auth' }))).toBe('x');
  });
  test('turns a fetch failure into a connection hint', () => {
    expect(friendlyErrorMessage(new TypeError('Failed to fetch'))).toMatch(/couldn.t reach/i);
  });
  test('falls back to a plain error message', () => {
    expect(friendlyErrorMessage(new Error('boom'))).toBe('boom');
  });
});
