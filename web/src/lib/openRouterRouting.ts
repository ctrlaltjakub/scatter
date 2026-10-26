import { listOpenRouterTextEndpoints } from '@/providers/openrouter';
import { resolveBaseUrl } from '@/providers/registry';
import type { ProviderAccount } from '@/store/types';
import { modelCatalogRequestKey, useModelCatalogStore } from '@/store/useModelCatalogStore';

/** Refresh recent endpoint latency and route-specific prices without blocking
 * the model picker. The store deduplicates requests and caps concurrency. */
export async function refreshOpenRouterRouteMetadata(
  account: ProviderAccount,
  models: Iterable<string>,
  options: { force?: boolean } = {},
): Promise<void> {
  if (account.preset !== 'openrouter' || !account.apiKey.trim()) return;
  const ids = [...new Set(models)].filter(Boolean);
  if (!ids.length) return;
  const requestKey = modelCatalogRequestKey(account);
  const baseUrl = resolveBaseUrl(account.preset, account.baseUrl);
  await Promise.allSettled(ids.map((model) =>
    useModelCatalogStore.getState().refreshEndpoints(
      account.id,
      model,
      requestKey,
      () => listOpenRouterTextEndpoints(account.apiKey, model, baseUrl),
      options,
    ),
  ));
}
