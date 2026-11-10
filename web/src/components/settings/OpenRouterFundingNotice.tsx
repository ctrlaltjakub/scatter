import type { OpenRouterAccountInfo } from '@/lib/openRouterAccount';

/** Free-tier status is not a balance or evidence of a missing payment card. */
export function OpenRouterFundingNotice({ account }: { account?: OpenRouterAccountInfo }) {
  if (!account) return null;
  const budget = account.effective_budget;
  const keyLimited = account.limit_remaining != null && account.limit_remaining <= 0;
  const budgetLimited = budget && budget.remaining_usd <= 0;
  const free = account.is_free_tier === true;
  if (!keyLimited && !budgetLimited && !free) return null;
  return <aside className="provider-funding-notice" aria-label="OpenRouter billing">
    {keyLimited || (budgetLimited && budget.scope === 'key_limit')
      ? <p><strong>This API key has reached its spending limit.</strong> <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">Review the key limit</a> or wait for it to reset.</p>
      : budgetLimited && <p><strong>An OpenRouter workspace budget has been reached.</strong> Ask the workspace administrator to review the limit.</p>}
    {free && <p><strong>OpenRouter reports a free-tier account.</strong> For paid models, <a href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener noreferrer">check or add credits</a>. You can also choose a free model.</p>}
  </aside>;
}
