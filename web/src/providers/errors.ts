/**
 * Typed provider errors. The adapters used to throw raw
 * `Error("streamChat failed: 401 … {json}")` strings that landed unfiltered on
 * the node / in the connect form. This normalizes an HTTP status + body into a
 * short, human message the UI can show directly.
 */
export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'insufficient_credits'
  | 'context'
  | 'output_limit'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'unknown';

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  constructor(message: string, opts: { kind: ProviderErrorKind; status?: number; retryable?: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = 'ProviderError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? (opts.kind === 'rate_limit' || opts.kind === 'server');
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Pull the provider's own error message out of a JSON body, if present. */
export function extractProviderMessage(bodyText: string): string {
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string }; message?: string };
    return (j?.error?.message ?? j?.message ?? '').toString().trim().slice(0, 200);
  } catch {
    return bodyText.trim().slice(0, 200);
  }
}

/** Map an HTTP status + response body to a typed, human-readable error. */
export function normalizeProviderError(
  status: number | undefined,
  bodyText: string,
  retryAfter?: string | null,
): ProviderError {
  const detail = extractProviderMessage(bodyText);
  const retrySeconds = retryAfter == null ? Number.NaN : Number(retryAfter);
  const retryDate = retryAfter && Number.isNaN(retrySeconds) ? Date.parse(retryAfter) : Number.NaN;
  const retryAfterMs = Number.isFinite(retrySeconds)
    ? Math.max(0, retrySeconds * 1000)
    : Number.isFinite(retryDate)
      ? Math.max(0, retryDate - Date.now())
      : undefined;
  if (status === 401 || status === 403) {
    return new ProviderError('The API key was rejected — check it in Settings.', { kind: 'auth', status });
  }
  // OpenAI uses HTTP 429 for exhausted billing quota as well as transient
  // throttling. Waiting/retrying cannot repair an empty balance or budget.
  if (status === 402 || (status === 429 && /insufficient_quota|billing_hard_limit_reached|exceeded.*(?:current )?quota|no credits remaining|credit balance.*(?:low|insufficient)/i.test(bodyText))) {
    return new ProviderError('This provider has no available credits or has reached its spending limit — check its API billing and project budget.', { kind: 'insufficient_credits', status });
  }
  if (status === 429) {
    return new ProviderError('Rate limit hit — wait a moment and try again.', {
      kind: 'rate_limit', status, retryAfterMs,
    });
  }
  if (status === 400 && /(?:max_(?:completion_|output_)?tokens|output.tokens|completion.tokens).*(?:too (?:large|high)|cannot exceed|exceeds|at most|less than|maximum|upper bound)/i.test(detail)
    && !/context|input|prompt|combined/i.test(detail)) {
    return new ProviderError('The requested output allowance exceeds this model’s supported limit. Lower it in Settings → Models and generation → Generation token limits, or choose a model with a larger output limit.', { kind: 'output_limit', status });
  }
  if (status === 400 && /context[_ ](?:length|window)|remaining context|too (?:many input tokens|long)|maximum.*token|token.*(limit|exceed)|reduce the length/i.test(bodyText)) {
    return new ProviderError('The input and requested output allowance do not fit this model’s context window. Lower the token limit in Settings → Models and generation → Generation token limits, shorten or compact the conversation, or increase the loaded context size on your local server. Search results and tool instructions also use context.', { kind: 'context', status });
  }
  if (status === 400) {
    return new ProviderError(detail ? `The provider rejected the request: ${detail}` : 'The provider rejected the request.', { kind: 'bad_request', status });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError(`The provider had a server error (${status}) — usually temporary, try again.`, { kind: 'server', status, retryable: true });
  }
  if (status === undefined) {
    return new ProviderError("Couldn't reach the provider — check your connection, and the Base URL for local/custom providers.", { kind: 'network' });
  }
  return new ProviderError(detail ? `Provider error (${status}): ${detail}` : `Provider error (${status}).`, { kind: 'unknown', status });
}

/** Turn any thrown value into a short message safe to show the user. A
 *  ProviderError already carries one; a raw network TypeError ("Failed to
 *  fetch") becomes a connection hint; anything else falls back to its message. */
export function friendlyErrorMessage(e: unknown): string {
  if (e instanceof ProviderError) return e.message;
  const msg = (e as Error)?.message ?? String(e);
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) {
    return "Couldn't reach the provider — check your connection, and the Base URL for local/custom providers.";
  }
  return msg;
}
