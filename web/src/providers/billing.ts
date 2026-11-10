type Failure = { message: string; temporary?: boolean };
const exhausted = /insufficient_quota|billing_hard_limit_reached|credit_balance_exhausted|(?:organization|project)_(?:spend|usage)_limit_exceeded|enforced_spend_limit_reached/;
const creditText = /insufficient credits|(?:credit balance|balance of credits).{0,32}(?:low|insufficient|exhausted)|no credits remaining|exceeded (?:your )?current quota/i;
const capText = /(?:spend(?:ing)? (?:cap|limit)|monthly API usage threshold).{0,35}(?:exceed|reach)|(?:exceed|reach|cross).{0,55}(?:spend(?:ing)? (?:cap|limit)|monthly API usage threshold)/i;

/** Only attribute a billing system to its own endpoint, never to a model name. */
export function billingFailure(status: number | undefined, raw: string, endpoint?: string): Failure | null {
  if (status !== undefined && ![400, 402, 403, 429].includes(status)) return null;
  let host = '';
  try { if (endpoint) host = new URL(endpoint).hostname; } catch { /* custom endpoint */ }
  let error;
  try { error = JSON.parse(raw)?.error; } catch { /* some providers return plain text */ }
  const code = [error?.type, error?.code, error?.details?.error_code].join(' ');
  const message = String(error?.message ?? raw);
  const source = error?.metadata?.limit_source;
  if (host === 'openrouter.ai') {
    if (source === 'openrouter_in_flight_budget') return { temporary: true, message: 'OpenRouter has reserved credits for other requests. Wait for them to settle, then retry.' };
    if (source === 'openrouter_key_limit') return { message: 'This OpenRouter API key has reached its spending limit. Open Settings → OpenRouter → Manage spending limit, or wait for the limit to reset.' };
    if (source === 'openrouter_workspace_budget' || source === 'openrouter_guardrail_budget') return { message: 'An OpenRouter workspace spending limit blocked this request. Ask the workspace administrator to review the budget, or wait for it to reset.' };
    if (source === 'openrouter_credits' || status === 402 || creditText.test(message)) return {
      message: 'OpenRouter could not cover this request. Check Settings → OpenRouter → Manage credits and add credits if needed. If you already have funds, check the key’s spending limit or reduce the output token limit.',
    };
  }
  if (status !== 402 && !exhausted.test(code) && !creditText.test(message) && !capText.test(message) && !/\bbilling_error\b/.test(code)) return null;
  if (host === 'api.openai.com') return { message: /spend|usage_limit/.test(code) || capText.test(message)
    ? 'OpenAI reports a spending limit. Review your organization or project limits on the OpenAI Platform, then retry.'
    : 'OpenAI reports insufficient API quota. Check the balance and payment details in OpenAI Platform → Billing, and the limits for this project.' };
  if (host === 'api.anthropic.com') return { message: capText.test(message) || /spend_limit/.test(code)
    ? 'Anthropic reports a spending limit. Review the organization and workspace limits in the Claude Console, or wait for the limit to reset.'
    : 'Anthropic could not bill this request. Open Billing in the Claude Console to check your credit balance and payment details, then retry.' };
  return { message: 'The provider reports a billing or spending limit. Check the account balance and project budget with that provider, or contact your server administrator.' };
}
