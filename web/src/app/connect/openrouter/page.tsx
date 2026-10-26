'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { completeOpenRouterConnection } from '@/lib/openRouterConnect';
import { readOnboardingSession, saveOnboardingSession } from '@/lib/onboardingSession';
import { useSettingsStore } from '@/store/useSettingsStore';
import { settingsSnapshot } from '@/store/settingsSnapshot';
import { newId } from '@/lib/ids';
import { appPath } from '@/lib/deployment';

let completion: Promise<void> | undefined;
function finishConnection() {
  return completion ??= (async () => {
    const key = await completeOpenRouterConnection();
    if (!useSettingsStore.getState().hydrated) await useSettingsStore.getState().hydrate();
    const state = useSettingsStore.getState();
    const previous = state.providers.find(p => p.preset === 'openrouter');
    const provider = { ...(previous ?? { id: newId(), preset: 'openrouter' as const, enabledModels: [] }), apiKey: key };
    await state.replaceSettings({ ...settingsSnapshot(state), providers: previous
      ? state.providers.map(p => p.id === previous.id ? provider : p) : [provider, ...state.providers] });
    saveOnboardingSession(readOnboardingSession()?.path ?? 'quick', 'review');
  })();
}

export default function OpenRouterCallback() {
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void finishConnection().then(() => { if (!cancelled) window.location.replace(appPath()); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not complete the connection. Please try again.'); });
    return () => { cancelled = true; };
  }, []);
  return <main className="welcome"><section className="welcome-card" aria-live="polite">
    <h1 className="welcome-tagline">{error ? 'Connection needs attention' : 'Connecting OpenRouter'}</h1>
    {error ? <><p role="alert" className="field-help">{error}</p><a href={appPath()} className="btn btn-primary">Return to setup</a></>
      : <p className="welcome-blurb"><LoaderCircle size={18} className="spin" /> Checking and saving your connection. No paid request is made.</p>}
  </section></main>;
}
