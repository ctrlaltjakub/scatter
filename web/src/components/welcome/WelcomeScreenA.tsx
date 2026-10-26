'use client';
import { ModelDiagnostics } from '../settings/ModelDiagnostics';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CloudDownload, Download, ExternalLink, KeyRound, Sparkles } from 'lucide-react';
import { ProvidersTab } from '@/components/SettingsModal';
import { ModelAssignments } from '@/components/settings/ModelAssignments';
import { ModelUpdateSettings } from '@/components/settings/ModelUpdateSettings';
import { OpenRouterAccount } from '@/components/settings/OpenRouterAccount';
import { SettingsToggle } from '@/components/settings/SettingsSection';
import { SelectedModelDetails } from '@/components/settings/SelectedModelDetails';
import { SyncDataSettings } from '@/components/SyncDataSettings';
import { useSettingsStore } from '@/store/useSettingsStore';
import { modelCatalogRequestKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { imagePricingKey, useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { useSyncStore } from '@/store/useSyncStore';
import { settingsSnapshot } from '@/store/settingsSnapshot';
import { getAdapter, getImageAdapter, resolveBaseUrl } from '@/providers/registry';
import { friendlyErrorMessage } from '@/providers/errors';
import { applySettingsUiPreferences, parseSettingsFile, SettingsImportError } from '@/lib/settingsTransfer';
import { applySettingsImport } from '@/lib/applySettingsImport';
import { readOpenRouterAccount } from '@/lib/openRouterAccount';
import { beginOpenRouterConnection } from '@/lib/openRouterConnect';
import { clearOnboardingSession, readOnboardingSession, saveOnboardingSession, type OnboardingPath, type OnboardingStep } from '@/lib/onboardingSession';
import { MODEL_ROLES, RECOMMENDED_MODELS, recommendedModelAvailable, roleRef } from '@/lib/recommendedModels';
import { resumeSync } from '@/sync/actions';
import { initializeSyncCoordinator } from '@/sync/coordinator';
import { compactImagePriceLabel } from '@/lib/imagePricing';
import { missingSetupConnections, restoreMissingCredentials, validateOnboardingModels } from '@/lib/onboardingSetup';
import { modelDisplayName } from '@/lib/modelDisplay';
import { ThemeToggleButton } from '@/components/ThemeToggleButton';
import { isProviderEnabled } from '@/providers/providerPolicy';

export function WelcomeScreenA() {
  const providers = useSettingsStore(s => s.providers);
  const [canCancel] = useState(() => !!useSettingsStore.getState().activeModelRef && !readOnboardingSession());
  const active = useSettingsStore(s => s.activeModelRef);
  const secondaryRef = useSettingsStore(s => s.secondaryModelRef);
  const interactiveRef = useSettingsStore(s => s.interactiveModelRef);
  const imageRef = useSettingsStore(s => s.imageModelRef);
  const preferences = useSettingsStore(s => s.modelRecommendations);
  const autoPreviews = useSettingsStore(s => s.autoTermPreviews);
  const autoImages = useSettingsStore(s => s.autoFreeImages);
  const [path, setPath] = useState<OnboardingPath>('quick');
  const [step, setStep] = useState<OnboardingStep>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [resumeSyncOnFinish, setResumeSyncOnFinish] = useState(false);
  // Setup acknowledgment is transient UI state, not a canvas undo action.
  const [confirmed, setConfirmed] = useState(false);
  const settingsInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const textCatalogs = useModelCatalogStore(s => s.catalog);
  const imageCatalogs = useImageModelCatalogStore(s => s.catalog);
  const imagePricing = useImageModelCatalogStore(s => s.pricing);
  const openRouter = providers.find(p => p.preset === 'openrouter' && p.apiKey.trim());

  useEffect(() => {
    const saved = readOnboardingSession();
    if (saved) {
      setPath(saved.path); setStep(saved.step);
      setRestored(saved.path === 'restore' && !saved.syncPicker);
      setShowSync(saved.syncPicker === true); setResumeSyncOnFinish(saved.restoreSync === true);
    }
    useSettingsStore.getState().setForceWelcomeA(true);
  }, []);

  const navigate = (next: OnboardingStep, nextPath = path) => {
    setPath(nextPath); setStep(next); setError('');
    saveOnboardingSession(nextPath, next);
    requestAnimationFrame(() => heading.current?.focus());
  };

  const loadCatalogs = async () => {
    const accounts = useSettingsStore.getState().providers.filter(p => isProviderEnabled(p.preset) && p.apiKey.trim());
    if (!accounts.length) throw new Error('Connect at least one AI provider to continue.');
    await Promise.all(accounts.map(async account => {
      if (account.preset === 'openrouter') await readOpenRouterAccount(account.apiKey, AbortSignal.timeout(20_000));
      const key = modelCatalogRequestKey(account);
      const base = resolveBaseUrl(account.preset, account.baseUrl);
      await useModelCatalogStore.getState().refreshCatalog(account.id, key,
        () => getAdapter(account.preset).listModels(account.apiKey, base));
      const imageAdapter = getImageAdapter(account.preset);
      if (imageAdapter) await useImageModelCatalogStore.getState().refreshCatalog(account.id, key,
        () => imageAdapter.listModels(account.apiKey, base)).catch(() => undefined);
    }));
  };

  const prepare = async () => {
    setBusy(true); setError('');
    try {
      await loadCatalogs();
      const state = useSettingsStore.getState();
      const account = state.providers.find(p => p.preset === 'openrouter' && p.apiKey.trim());
      if (path === 'quick' && account && !readOnboardingSession()?.recommendationsApplied) {
        // Choosing quick setup explicitly opts into the curated set once. Never
        // repeat enrollment after the user customizes their review screen.
        MODEL_ROLES.forEach(role => state.setModelAutoUpdate(role, true));
        state.applyRecommendedModels(account.id, true);
        saveOnboardingSession('quick', 'review', { recommendationsApplied: true });
      }
      setCatalogReady(true);
      navigate('review');
    } catch (cause) { setError(friendlyErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const autoPrepared = useRef(false);
  useEffect(() => {
    if (step !== 'review' || catalogReady || autoPrepared.current || busy) return;
    autoPrepared.current = true;
    void prepare();
  // A redirect automatically checks catalogs once; retries are explicit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, catalogReady, busy]);

  useEffect(() => {
    if (step !== 'review' || !imageRef) return;
    const account = providers.find(p => p.id === imageRef.providerId && p.apiKey.trim());
    const adapter = account && getImageAdapter(account.preset);
    if (!account || !adapter?.listPricing) return;
    void useImageModelCatalogStore.getState().refreshPricing(account.id, imageRef.model, modelCatalogRequestKey(account),
      () => adapter.listPricing!(account.apiKey, imageRef.model, resolveBaseUrl(account.preset, account.baseUrl))).catch(() => undefined);
  }, [step, imageRef, providers]);

  const connectOpenRouter = async () => {
    setBusy(true); setError('');
    saveOnboardingSession(path, 'connect');
    try { await beginOpenRouterConnection(); }
    catch { setError('Could not open the secure connection. Allow session storage, or add an API key in custom setup.'); setBusy(false); }
  };

  const importSettings = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy) return;
    setBusy(true); setError('');
    try {
      const imported = await parseSettingsFile(file);
      imported.settings = restoreMissingCredentials(imported.settings, useSettingsStore.getState());
      await applySettingsImport(imported);
      applySettingsUiPreferences(imported.uiPreferences);
      setRestored(true); setShowSync(false); setCatalogReady(false); setResumeSyncOnFinish(false);
      const missing = missingSetupConnections(imported.settings).length > 0;
      autoPrepared.current = false;
      const next = missing || !imported.settings.providers.some(p => p.apiKey.trim()) ? 'connect' : 'review';
      saveOnboardingSession('restore', next, { restoreSync: false, syncPicker: false });
      navigate(next, 'restore');
    } catch (cause) {
      setError(cause instanceof SettingsImportError ? cause.message : 'Settings could not be saved on this device. Please try again.');
    } finally { setBusy(false); }
  };

  const finish = async () => {
    if (step !== 'confirm' || !confirmed) return;
    setBusy(true); setError('');
    try {
      await loadCatalogs();
      const state = useSettingsStore.getState();
      if (path === 'quick') {
        const missing = MODEL_ROLES.filter(role => state.modelRecommendations?.[role].autoUpdate
          && !(role === 'image' && state.imageModelRef === null) && !roleRef(state, role));
        if (missing.length) throw new Error('Some recommended models are unavailable. Choose alternatives in Customize models before continuing.');
      }
      const selected = validateOnboardingModels(state, useModelCatalogStore.getState().catalog, useImageModelCatalogStore.getState().catalog);
      await state.replaceSettings({ ...settingsSnapshot(state), activeModelRef: { providerId: selected.providerId, model: selected.model } });
      // Imports suspend the coordinator while replacing settings. Unlike the
      // previous welcome screen, this flow finishes without reloading the app.
      await initializeSyncCoordinator();
      if (resumeSyncOnFinish && useSyncStore.getState().config.provider) await resumeSync();
      clearOnboardingSession();
      state.setForceWelcomeA(false);
    } catch (cause) { setError(friendlyErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true); setError('');
    try { await initializeSyncCoordinator(); clearOnboardingSession(); useSettingsStore.getState().setForceWelcomeA(false); }
    catch (cause) { setError(friendlyErrorMessage(cause)); }
    finally { setBusy(false); }
  };
  const steps: Array<{ id: OnboardingStep; title: string; detail: string }> = [
    { id: 'choose', title: 'Choose your setup', detail: 'Quick, custom, or restore' },
    { id: 'connect', title: path === 'restore' ? 'Restore and connect' : 'Connect your AI', detail: path === 'quick' ? 'One OpenRouter connection' : 'Your providers and keys' },
    { id: 'review', title: path === 'custom' ? 'Choose your models' : 'Review your setup', detail: 'Models, costs, and controls' },
    { id: 'confirm', title: 'Confirm usage', detail: 'Age, reliability, and responsibility' },
  ];
  const stepIndex = steps.findIndex(s => s.id === step);
  const titles = step === 'choose' ? ['Configure AI models', 'Use recommended models, configure providers manually, or restore an existing setup.']
    : showSync ? ['Restore synchronized settings', 'Connect the storage provider configured on your other device.']
    : step === 'connect' ? [path === 'quick' ? 'Connect OpenRouter' : restored ? 'Settings restored' : 'Configure providers',
      restored ? 'Your model choices are saved. Add the missing API keys to use them on this device.' : path === 'quick' ? 'One OpenRouter connection provides access to all four recommended models.' : 'Add API keys and configure model provider connections.']
    : step === 'confirm' ? ['Confirm before continuing', 'Read the statements below, then confirm to finish setup.']
    : ['Review model configuration', 'You can change models or add more API providers later in Settings.'];
  const showRecommendations = path === 'quick' && !customize;
  const incomplete = path === 'quick' && catalogReady && openRouter
    ? MODEL_ROLES.filter(role => (role !== 'image' || imageRef !== null)
      && preferences?.[role].autoUpdate !== false
      && !recommendedModelAvailable(role, textCatalogs[openRouter.id] ?? [], imageCatalogs[openRouter.id] ?? [])) : [];

  return <main className="welcome onboarding">
    <section className="onboarding-shell settings-modal" aria-label="Set up Scatter">
      <aside className="onboarding-rail">
        <div className="onboarding-brand">Scatter<span>Model configuration</span></div>
        <nav aria-label="Setup progress"><ol className="onboarding-timeline">
          {steps.map((item, index) => <li key={item.id} className={index === stepIndex ? 'is-current' : index < stepIndex ? 'is-complete' : ''}>
            <button disabled={busy || index > stepIndex} aria-current={item.id === step ? 'step' : undefined}
              onClick={() => { setShowSync(false); navigate(item.id); }}>
              <span className="onboarding-dot">{index < stepIndex ? <Check size={12} /> : index + 1}</span>
              <span><strong>{item.title}</strong><small>{item.detail}</small></span>
            </button>
          </li>)}
        </ol></nav>
        <div className="onboarding-theme-control"><ThemeToggleButton /></div>
      </aside>
      <div className="onboarding-main">
        <header className="settings-page-heading"><span className="settings-eyebrow">{path === 'quick' ? 'Quick setup' : path === 'custom' ? 'Custom setup' : 'Restore your setup'} · Step {stepIndex + 1} of {steps.length}</span>
          <h1 ref={heading} tabIndex={-1}>{titles[0]}</h1><p>{titles[1]}</p></header>
        <fieldset className="onboarding-content" disabled={busy}>
          <input ref={settingsInput} type="file" accept=".json,application/json" aria-label="Settings file" hidden disabled={busy} onChange={event => void importSettings(event)} />
          {step === 'choose' && <>
            <div className="onboarding-choices">
              <button className="onboarding-choice" data-tip="Set up OpenRouter with recommended models" disabled={busy} onClick={() => navigate('connect', 'quick')}>
                <Sparkles size={22} /><span className="onboarding-choice-body"><span className="onboarding-recommended">Recommended</span><strong>Quick setup</strong>
                  <span>Connect OpenRouter to use the recommended model configuration.</span><small>You can change models or add more API providers later.</small></span><ArrowRight size={18} />
              </button>
              <button className="onboarding-choice" data-tip="Set up your own providers and models" disabled={busy} onClick={() => navigate('connect', 'custom')}>
                <KeyRound size={22} /><span className="onboarding-choice-body"><strong>Choose your own models</strong><span>Add provider API keys and choose a model for each role.</span><small>Cloud providers, local models, or your own server.</small></span><ArrowRight size={18} />
              </button>
            </div>
            <div className="onboarding-restore"><h2>Restore existing settings</h2><p>Import settings from another device. If API keys are missing, reconnect only those providers.</p>
              <div className="sync-button-row"><button className="btn btn-secondary" disabled={busy} onClick={() => {
                setShowSync(true); setRestored(false); navigate('connect', 'restore');
                saveOnboardingSession('restore', 'connect', { syncPicker: true });
              }}><CloudDownload size={15} /> Restore from sync</button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => settingsInput.current?.click()}><Download size={15} /> {busy ? 'Importing settings…' : 'Import settings file'}</button></div>
            </div>
          </>}
          {step === 'connect' && (showSync ? <>
            <p className="field-help"><strong>Settings are downloaded first.</strong> API keys are restored if <strong>Sync model-provider API keys</strong> was enabled on your other device. Otherwise, reconnect the missing providers in the next step.</p>
            <SyncDataSettings onWorkingChange={setBusy} onRestored={() => {
              setRestored(true); setShowSync(false); setResumeSyncOnFinish(true); setCatalogReady(false); setError('');
              autoPrepared.current = false;
              const restoredSettings = useSettingsStore.getState();
              const next = missingSetupConnections(restoredSettings).length || !restoredSettings.providers.some(p => p.apiKey.trim()) ? 'connect' : 'review';
              saveOnboardingSession('restore', next, { restoreSync: true, syncPicker: false });
              navigate(next, 'restore');
            }} />
          </> : path === 'quick' ? <>
            <div className="onboarding-connect-card"><Sparkles size={26} /><h2>Connect with OpenRouter</h2>
              <p>Sign in or create an OpenRouter account. Authorize access for the app; the API key is saved automatically when you return.</p>
              <button className="btn btn-primary" disabled={busy} onClick={() => void connectOpenRouter()}>Connect OpenRouter <ArrowRight size={16} /></button>
              {openRouter && <button className="btn btn-secondary" disabled={busy} onClick={() => void prepare()}>Use existing OpenRouter connection</button>}
            </div>
            <div className="onboarding-facts"><p><strong>Usage-based billing.</strong> Paid models use OpenRouter credits, separate from ChatGPT, Claude, or Gemini subscriptions. New users may need to add credits on OpenRouter.</p>
              <p><strong>Spending limits.</strong> Set a limit for this app’s API key and review usage in Settings → OpenRouter.</p>
              <p><strong>Credential storage.</strong> The key is stored in this browser’s local data. Prompts go to OpenRouter and the model provider. Cloud sync excludes keys by default; you can enable key syncing in Settings → Synchronization. Full settings exports can include keys.</p></div>
            <button className="settings-text-action" disabled={busy} onClick={() => navigate('connect', 'custom')}>Add an API key manually</button>
          </> : <>
            {restored && <div className="settings-callout"><Check size={18} /><p><strong>Model choices preserved.</strong> Add API keys to the restored provider connections below. Models can be changed on the next step.</p></div>}
            {restored && providers.some(p => p.preset === 'openrouter' && !p.apiKey.trim()) && <button className="btn btn-secondary onboarding-reconnect" disabled={busy} onClick={() => void connectOpenRouter()}>Reconnect OpenRouter <ExternalLink size={14} /></button>}
            <ProvidersTab onboarding />
          </>)}
          {step === 'review' && <>
            {busy && !catalogReady && <p role="status" className="field-help">Checking your connection and available models… No paid request is made.</p>}
            {incomplete.length > 0 && <p role="alert" className="sync-settings-error">These recommendations are currently unavailable: {incomplete.map(role => RECOMMENDED_MODELS[role].name).join(', ')}. No replacement was selected. Choose another model below{incomplete.includes('image') ? ', or turn image generation off' : ''}.</p>}
            {showRecommendations && <div className="onboarding-models">
              {MODEL_ROLES.map(role => {
                const model = RECOMMENDED_MODELS[role];
                const ref = role === 'main' ? active : role === 'secondary' ? secondaryRef : role === 'interactive' ? interactiveRef : imageRef;
                const provider = providers.find(p => p.id === ref?.providerId);
                const image = ref ? imageCatalogs[ref.providerId]?.find(item => item.id === ref.model) : undefined;
                const price = ref ? imagePricing[imagePricingKey(ref.providerId, ref.model)] ?? image?.pricing : undefined;
                const name = ref ? ref.model === model.id ? model.name : modelDisplayName(ref.model) : role === 'image' && imageRef === null ? 'Image generation off' : 'Choose a model';
                return <div className="onboarding-model" key={role}><div className="onboarding-model-heading"><span><small>{model.label}</small><strong>{name}</strong></span></div>
                  <p>{model.purpose}</p>
                  {ref && provider && role !== 'image' && <SelectedModelDetails providerId={ref.providerId} preset={provider.preset} model={ref.model} />}
                  {role === 'image' && imageRef && <p className="field-help"><strong>Cost:</strong> {compactImagePriceLabel(price) || 'Not reported by this provider'}. Actual price depends on resolution and quality. {image?.supportsImageEditing ? 'Supports image generation and editing.' : ''}</p>}
                </div>;
              })}
            </div>}
            {path === 'quick' && <button className="btn btn-secondary" aria-expanded={customize} onClick={() => setCustomize(value => !value)}>{customize ? 'Show setup summary' : 'Customize models'}</button>}
            {(!showRecommendations || incomplete.length > 0) && <ModelAssignments />}
            <details className="onboarding-details"><summary>Automatic model updates</summary><ModelUpdateSettings embedded /></details>
            <ModelDiagnostics embedded />
            <details className="onboarding-details"><summary>Automatic activity</summary><p className="field-help">These background tasks use the secondary model and may incur charges. You can change them later in Settings.</p>
              <SettingsToggle title="Generate term previews automatically" description="Create short explanations for terms you can hover over." checked={autoPreviews} onChange={useSettingsStore.getState().setAutoTermPreviews} />
              <SettingsToggle title="Search for free images automatically" description={<>Search <strong>Wikimedia Commons</strong> and <strong>Openverse</strong> for <strong>encyclopedic and answer nodes</strong>. The secondary model generates search queries and reviews results.</>} checked={autoImages} onChange={useSettingsStore.getState().setAutoFreeImages} />
            </details>
            {openRouter && <details className="onboarding-details"><summary>Spending limits and usage</summary><OpenRouterAccount /></details>}
          </>}
          {step === 'confirm' && <div className="onboarding-confirmations">
            <div className="onboarding-confirmation">
              <div id="onboarding-usage-statements" className="onboarding-confirmation-statements">
                <p><strong>I confirm that I am 18 or older.</strong></p>
                <p><strong>I understand that AI models can hallucinate.</strong> They can generate incorrect, misleading, or fabricated information. I am responsible for checking outputs before relying on them.</p>
                <p><strong>I accept responsibility for my use of the app and provider APIs.</strong> This includes content I generate, use, or share, token usage, provider charges, and compliance with applicable laws and provider terms. To the extent permitted by law, Scatter and its developers are not liable for model outputs, costs, or my use of the app or APIs.</p>
              </div>
              <label className="onboarding-confirmation-accept">
                <input type="checkbox" checked={confirmed} aria-describedby="onboarding-usage-statements"
                  onChange={event => setConfirmed(event.target.checked)} />
                <span>I confirm and accept all statements above.</span>
              </label>
            </div>
          </div>}
          {error && <p role="alert" className="sync-settings-error">{error}</p>}
        </fieldset>
        <footer className="onboarding-footer">
          <div>{step !== 'choose' && <button className="btn btn-ghost" disabled={busy} onClick={() => { setShowSync(false); navigate(step === 'confirm' ? 'review' : step === 'review' ? 'connect' : 'choose'); }}><ArrowLeft size={14} /> Back</button>}
            {canCancel && <button className="btn btn-ghost" disabled={busy} onClick={() => void cancel()}>Return to app</button>}</div>
          {step === 'connect' && path !== 'quick' && !showSync && <button className="btn btn-primary" disabled={busy} onClick={() => void prepare()}>{busy ? 'Checking connection…' : restored ? 'Review restored setup' : 'Choose models'} <ArrowRight size={15} /></button>}
          {step === 'review' && <button className="btn btn-primary" disabled={busy || !providers.some(p => p.enabledModels.length && p.apiKey.trim())} onClick={() => navigate('confirm')}>Continue <ArrowRight size={15} /></button>}
          {step === 'confirm' && <button className="btn btn-primary" disabled={busy || !confirmed} onClick={() => void finish()}>{busy ? 'Checking setup…' : 'Finish setup'} <ArrowRight size={15} /></button>}
        </footer>
      </div>
    </section>
  </main>;
}
