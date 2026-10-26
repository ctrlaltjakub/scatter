'use client';
import { useSettingsStore } from '@/store/useSettingsStore';
import { MODEL_ROLES, RECOMMENDED_MODELS, recommendationPreferences } from '@/lib/recommendedModels';
import { CollapsibleSection } from '../dev/CollapsibleSection';
import { SettingsToggle } from './SettingsSection';

export function ModelUpdateSettings({ embedded = false }: { embedded?: boolean }) {
  const preferences = useSettingsStore(s => s.modelRecommendations);
  const setAll = useSettingsStore(s => s.setAllModelAutoUpdates);
  const setAutoUpdate = useSettingsStore(s => s.setModelAutoUpdate);
  const prefs = recommendationPreferences({ modelRecommendations: preferences });
  const enabledCount = MODEL_ROLES.filter(role => prefs[role].autoUpdate).length;
  const content = <>
    <p className="field-help">Updates <strong>keep your provider</strong>. They run only if its API offers the recommended model with the required capabilities. Otherwise, <strong>your current model stays unchanged</strong>.</p>
    <p className="field-help">Main-model updates replace <strong>your entire main-model list with the single recommended model</strong> and make it active. Editing a role’s model choices turns its updates off.</p>
    <SettingsToggle title="Update all model roles" checked={enabledCount === MODEL_ROLES.length} onChange={setAll}
      description={<><strong>{enabledCount} of {MODEL_ROLES.length} roles enabled.</strong></>} />
    {MODEL_ROLES.map(role => <SettingsToggle key={role} title={<>Keep <strong>{role}</strong> model updated</>}
      checked={prefs[role].autoUpdate} onChange={enabled => setAutoUpdate(role, enabled)}
      description={<>Current recommendation: <strong>{RECOMMENDED_MODELS[role].name}</strong>.</>} />)}
    <p className="field-help">Updates wait for active generations. <strong>Prices may change.</strong> Disabled image generation stays off.</p>
  </>;
  // Onboarding already provides its own disclosure; keep one expansion step.
  return embedded ? content : <CollapsibleSection title="Automatic model updates"
    description={<>Update models when the app’s <strong>recommendations change</strong>.</>}>
    {content}
  </CollapsibleSection>;
}
