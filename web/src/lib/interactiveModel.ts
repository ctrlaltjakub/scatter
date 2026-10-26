import type { ActiveModelRef, ProviderAccount } from '@/store/types';
import type { ModelInfo } from '@/providers/types';

export interface InteractiveModelResolution {
  ref: ActiveModelRef | null;
  automatic: boolean;
}

function connected(provider: ProviderAccount | undefined): provider is ProviderAccount {
  return !!provider?.apiKey.trim();
}

/** Resolve the dedicated code model. An undefined preference deliberately
 * follows the active text model so "no separate choice" has one predictable
 * meaning in settings, onboarding, and generation. */
export function resolveInteractiveModel(input: {
  providers: ProviderAccount[];
  activeModelRef: ActiveModelRef | null;
  interactiveModelRef?: ActiveModelRef;
  catalog?: Record<string, ModelInfo[]>;
}): InteractiveModelResolution {
  const explicit = input.interactiveModelRef;
  if (explicit) {
    const provider = input.providers.find((item) => item.id === explicit.providerId);
    return { ref: connected(provider) ? explicit : null, automatic: false };
  }

  const activeProvider = input.providers.find(
    (provider) => provider.id === input.activeModelRef?.providerId,
  );
  return connected(activeProvider)
    && input.activeModelRef
    ? { ref: input.activeModelRef, automatic: true }
    : { ref: null, automatic: true };
}
