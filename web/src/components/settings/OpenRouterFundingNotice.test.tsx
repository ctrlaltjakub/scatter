import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { OpenRouterFundingNotice } from './OpenRouterFundingNotice';

it('explains free-tier funding without claiming a known balance or missing card', () => {
  render(<OpenRouterFundingNotice account={{is_free_tier: true, limit: null}} />);
  expect(screen.getByRole('link', {name: 'check or add credits'})).toHaveAttribute('href', 'https://openrouter.ai/settings/credits');
  expect(screen.getByText(/choose a free model/)).toBeVisible();
  expect(screen.queryByText(/no credits|no payment|empty balance/i)).toBeNull();
});
it('distinguishes an exhausted key from exhausted workspace funding', () => {
  const view = render(<OpenRouterFundingNotice account={{limit_remaining: -1}} />);
  expect(screen.getByRole('link', {name: 'Review the key limit'})).toBeVisible();
  view.rerender(<OpenRouterFundingNotice account={{limit: null, effective_budget: {scope: 'workspace', remaining_usd: -2}}} />);
  expect(screen.queryByRole('link', {name: 'Review the key limit'})).toBeNull();
  expect(screen.getByText(/workspace administrator/)).toBeVisible();
});
it('does not equate unreported data or an unlimited key with an empty balance', () => {
  const view = render(<OpenRouterFundingNotice account={{limit: null, limit_remaining: null}} />);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<OpenRouterFundingNotice />);
  expect(view.container).toBeEmptyDOMElement();
});
