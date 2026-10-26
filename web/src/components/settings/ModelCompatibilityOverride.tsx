'use client';

import type { ModelRole } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';

/** Shared by settings and onboarding; kept per role across catalog refreshes. */
export function ModelCompatibilityOverride({ role }: { role: ModelRole }) {
  const enabled = useSettingsStore(state => state.modelCompatibilityOverrides?.[role] === true);
  const setOverride = useSettingsStore(state => state.setModelCompatibilityOverride);
  return <label className="model-compatibility-inline">
    <input type="checkbox" role="switch" aria-label="Show all models" checked={enabled}
      onChange={event => setOverride(role, event.target.checked)} />
    <span>Show all models — bypass compatibility checks at your own risk.</span>
  </label>;
}
