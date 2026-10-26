'use client';
import { ReleaseFooter } from './settings/ReleaseFooter';
import { Fragment, useEffect, useRef, useState } from 'react';
import {
  X,
  Trash2,
  Upload,
  Download,
  Home,
  Plus,
  Check,
  RotateCcw,
  Pencil,
  CloudDownload,
  CloudOff,
  Search,
  Palette,
  Keyboard,
  Network,
  Sparkles,
  SlidersHorizontal,
  Cloud,
  Database,
  Code,
  FileText,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Sun,
  Moon,
  Monitor,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { PhysicsSliders } from './dev/PhysicsSliders';
import { useScreenshotStore } from '@/store/useScreenshotStore';
import { BulletSizingSliders } from './dev/BulletSizingSliders';
import { PromptsEditor } from './dev/PromptsEditor';
import { useSettingsStore } from '@/store/useSettingsStore';
import { languageInfo, languageDirection } from '@/lib/languages';
import { useReadingTypography } from '@/hooks/useReadingTypography';
import { NodeFontSettings } from './settings/NodeFontSettings';
import { isSingleConnectionProvider } from '@/store/providerSelectors';
import {
  DEFAULT_SETTINGS,
  type GroupColorAssignment,
  type OpenRouterRoutingPreference,
} from '@/store/types';
import {
  exportActiveScatterZip,
  importScatterFromFile,
  reassignActiveProjectColors,
} from '@/store/projectActions';
import { ProjectImportError } from '@/lib/projectTransfer';
import { downloadBlob } from '@/lib/download';
import {
  SettingsImportError,
  applySettingsUiPreferences,
  createSettingsExport,
  parseSettingsFile,
} from '@/lib/settingsTransfer';
import { getPreset, listPresets } from '@/providers/registry';
import { isProviderEnabled, providerDisabledReason } from '@/providers/providerPolicy';
import { ModelAssignments } from './settings/ModelAssignments';
import { ModelRolesGuide } from './settings/ModelRolesGuide';
import { OpenRouterAccount } from './settings/OpenRouterAccount';
import { ModelUpdateSettings } from './settings/ModelUpdateSettings';
import { LocalSearchConnection } from './settings/LocalSearchConnection';
import { SelectionWebSearchSettings } from './settings/SelectionWebSearchSettings';
import { isLocalSearchPreset } from '@/providers/modelSearch';
import { providerLabel } from './settings/providerLabel';
import { SettingsSection, SettingsToggle } from './settings/SettingsSection';
import { SETTINGS_PAGES, searchSettingsPages, type SettingsPageId } from './settings/settingsNavigation';
import { GenerationTokenLimits } from './settings/GenerationTokenLimits';
import { CollapsibleSection } from './dev/CollapsibleSection';
import { LocalModelGuide } from './settings/LocalModelGuide';
import { ModelDiagnostics } from './settings/ModelDiagnostics';
import { AnimatedCollapse } from './AnimatedCollapse';
import {
  KEY_ACTIONS,
  CONTEXT_SHORTCUTS,
  actionGlyph,
  bindingToGlyph,
  resolveBindings,
  bindingsEqual,
  bindingFromEvent,
  findAppConflict,
  isBrowserReserved,
  MAX_BINDINGS,
} from '@/lib/keymap';
import type { KeyBinding } from '@/store/types';
import type { ProviderAccount, ProviderPreset } from '@/store/types';
import { compareCaseInsensitive } from '@/store/providerSelectors';
import {
  applyThemePreference,
  DEFAULT_THEME_PREFERENCE,
  readThemePreference,
  THEME_CHANGE_EVENT,
  type ThemeChangeDetail,
  type ThemePreference,
} from '@/lib/theme';
import { SyncDataSettings } from './SyncDataSettings';
import { CameraSettings } from './settings/CameraSettings';
import { useSyncStore } from '@/store/useSyncStore';
import { applySettingsImport } from '@/lib/applySettingsImport';
import { useGraphStore } from '@/store/useGraphStore';
import { simulateGoogleDriveRenewalFailure, simulateRemoteProjectUpdateConflict } from '@/sync/coordinator';

function keyPlaceholder(preset: ProviderPreset): string {
  if (preset === 'openai') return 'sk-…';
  if (preset === 'anthropic') return 'sk-ant-…';
  if (preset === 'openrouter') return 'sk-or-…';
  return 'API key';
}

type Tab = SettingsPageId;

interface Props {
  open: boolean;
  onClose: () => void;
  initialPage?: SettingsPageId;
}

/* ---- Providers tab ---- */
function ProviderCard({
  account,
  expanded,
  onToggle,
}: {
  account: ProviderAccount;
  expanded: boolean;
  onToggle: () => void;
}) {
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const removeProvider = useSettingsStore((s) => s.removeProvider);
  const providers = useSettingsStore((s) => s.providers);
  const presetInfo = getPreset(account.preset);
  const presets = listPresets().sort((a, b) => compareCaseInsensitive(a.label, b.label));
  const showBaseUrl = !isSingleConnectionProvider(account.preset) || presetInfo.needsProxy;
  const [showKey, setShowKey] = useState(false);

  return (
    <div className={`sc-provider-card settings-provider-card${expanded ? ' is-open' : ''}`}>
      <button
        type="button"
        className="settings-provider-trigger"
        aria-label={`${providerLabel(account.preset, account.name)} connection`}
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`provider-${account.id}`}
      >
        <span className="settings-role-icon">
          <Network size={18} />
        </span>
        <span className="settings-provider-name">
          <strong>{providerLabel(account.preset, account.name)}</strong>
          <small>{account.name ? `${providerLabel(account.preset)} · ` : ''}API key and connection settings</small>
        </span>
        <span className={`settings-status${!account.apiKey ? ' is-muted' : ''}`}>
          {!isProviderEnabled(account.preset) ? 'Disabled' : account.apiKey ? 'Key added' : 'Needs setup'}
        </span>
        <ChevronDown size={15} className="settings-chevron" />
      </button>
      <AnimatedCollapse open={expanded} id={`provider-${account.id}`}>
        <div className="settings-provider-body">
          {providerDisabledReason(account.preset) && <p className="field-help" role="status">{providerDisabledReason(account.preset)} Your saved key and existing content are unchanged. Choose another provider for new requests.</p>}
          <div className="field-row">
            <label className="field-label" htmlFor={`provider-type-${account.id}`}>
              Provider
            </label>
            <select
              id={`provider-type-${account.id}`}
              className="input"
              value={account.preset}
              onChange={(e) =>
                updateProvider(account.id, { preset: e.target.value as ProviderPreset, enabledModels: [] })
              }
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id} disabled={!isProviderEnabled(p.id) || (isSingleConnectionProvider(p.id) && providers.some((other) => other.id !== account.id && other.preset === p.id))}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {!isSingleConnectionProvider(account.preset) && <div className="field-row">
            <label className="field-label" htmlFor={`provider-name-${account.id}`}>Connection name</label>
            <input id={`provider-name-${account.id}`} className="input" type="text" maxLength={80}
              value={account.name ?? ''} placeholder="For example: Home server"
              onChange={(event) => updateProvider(account.id, { name: event.target.value || undefined })} />
          </div>}

          {showBaseUrl && (
            <div className="field-row">
              <label className="field-label" htmlFor={`provider-url-${account.id}`}>
                Base URL
              </label>
              <input
                id={`provider-url-${account.id}`}
                type="text"
                className="input"
                value={account.baseUrl ?? ''}
                onChange={(e) => updateProvider(account.id, { baseUrl: e.target.value || undefined })}
                placeholder={presetInfo.defaultBaseUrl ?? 'https://…'}
              />
            </div>
          )}

          <div className="field-row">
            <label className="field-label" htmlFor={`provider-key-${account.id}`}>
              API key
            </label>
            <div className="settings-secret-field">
              <input
                id={`provider-key-${account.id}`}
                type={showKey ? 'text' : 'password'}
                className="input"
                value={account.apiKey}
                // Strip ALL whitespace + invisible chars: a key pasted from a wrapped
                // line (common on iOS/narrow screens) can carry an inner space,
                // newline, or zero-width char that breaks auth with a confusing 401.
                // Keys never contain whitespace or control/zero-width characters.
                onChange={(e) =>
                  updateProvider(account.id, {
                    apiKey: e.target.value.replace(/[\s\u0000-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, ''),
                  })
                }
                placeholder={keyPlaceholder(account.preset)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
          {isProviderEnabled(account.preset) && presetInfo.helpText && <p className="field-help">{presetInfo.helpText}</p>}
          {account.preset === 'openrouter' && <OpenRouterRoutingRow id={account.id} />}
          {isLocalSearchPreset(account.preset) && <LocalSearchConnection account={account} />}

          <button
            type="button"
            className="settings-text-action settings-danger-action"
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${providerLabel(account.preset, account.name)} and its saved key from the app? Models using this account will become unavailable.`,
                )
              )
                removeProvider(account.id);
            }}
          >
            <Trash2 size={14} /> Remove provider
          </button>
          {isLocalSearchPreset(account.preset) && <LocalModelGuide />}
        </div>
      </AnimatedCollapse>
    </div>
  );
}

/* ---- OpenRouter provider ordering ---- */
function OpenRouterRoutingRow({ id }: { id: string }) {
  const routing = useSettingsStore((s) => s.openRouterRouting);
  const setRouting = useSettingsStore((s) => s.setOpenRouterRouting);

  return (
    <>
      <div className="field-row">
        <label className="field-label" htmlFor={`openrouter-routing-${id}`}>
          OpenRouter routing
        </label>
        <select
          id={`openrouter-routing-${id}`}
          className="input"
          value={routing}
          onChange={(event) => setRouting(event.target.value as OpenRouterRoutingPreference)}
        >
          <option value="fast-start">Fast start — lowest wait for first text</option>
          <option value="lowest-cost">Cheapest providers</option>
        </select>
      </div>
      <p className="field-help">
        {routing === 'fast-start'
          ? <>Prioritizes the provider with the <strong>shortest wait for the first text</strong>.</>
          : <>Prioritizes the <strong>lowest-priced provider</strong> for the selected model.</>} Applies only to <strong>OpenRouter requests</strong>.
      </p>
    </>
  );
}

export function ProvidersTab({ onboarding = false }: { onboarding?: boolean } = {}) {
  const providers = useSettingsStore((s) => s.providers);
  const addProvider = useSettingsStore((s) => s.addProvider);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState<ProviderPreset>('openrouter');
  const presetAvailable = (id: ProviderPreset) => isProviderEnabled(id) && (!isSingleConnectionProvider(id) || !providers.some((p) => p.preset === id));
  const addingPreset = presetAvailable(preset) ? preset : listPresets().find((p) => presetAvailable(p.id))!.id;

  return (
    <>
      <div className="settings-callout">
        <ShieldCheck size={18} />
        <p>
          Your <strong>API keys stay on this device</strong>, unless you export them.
          AI requests go <strong>directly to your chosen provider</strong> from the browser.
        </p>
      </div>
      <div className="settings-inline-heading settings-providers-heading">
        <h3>
          Your connections <span>{providers.length}</span>
        </h3>
        {providers.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
          >
            <Plus size={14} /> Add provider
          </button>
        )}
      </div>
      <AnimatedCollapse open={adding || providers.length === 0}>
        <div className="settings-add-provider">
          <label htmlFor="new-provider">Choose a provider</label>
          <div className="settings-catalog-toolbar">
            <select
              className="input"
              id="new-provider"
              value={addingPreset}
              onChange={(event) => setPreset(event.target.value as ProviderPreset)}
            >
              {listPresets().map((provider) => (
                <option key={provider.id} value={provider.id} disabled={!presetAvailable(provider.id)}>
                  {provider.label}{!isProviderEnabled(provider.id) ? ' — currently disabled due to too restrictive terms and conditions' : !presetAvailable(provider.id) ? ' — already connected' : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const id = addProvider(addingPreset);
                setExpanded(id);
                setAdding(false);
              }}
            >
              <Plus size={14} /> Add
            </button>
          </div>
          <p className="field-help">{getPreset(addingPreset).helpText}</p>
          <p className="field-help"><strong>OpenRouter, Anthropic, and OpenAI</strong> each allow one connection. <strong>Local and custom providers</strong> allow multiple named connections.</p>
          {isLocalSearchPreset(addingPreset) && <LocalModelGuide />}
        </div>
      </AnimatedCollapse>
      <div className="sc-provider-cards">
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            account={p}
            expanded={expanded === p.id}
            onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
          />
        ))}
      </div>
      <ModelRolesGuide />
      {!onboarding && <div className="settings-footnote">
        Assign your connected models in <strong>Models and generation</strong>.
      </div>}
    </>
  );
}

/* ---- Generation and prompt settings ---- */
function GenerationSection() {
  const autoTermPreviews = useSettingsStore(s => s.autoTermPreviews);
  const setAutoTermPreviews = useSettingsStore(s => s.setAutoTermPreviews);
  const autoFreeImages = useSettingsStore(s => s.autoFreeImages);
  const setAutoFreeImages = useSettingsStore(s => s.setAutoFreeImages);
  return (
    <>
      <SettingsSection
        title="Model assignments"
        description={<>Each role can use a <strong>different model</strong>. Open a row to choose or configure it.</>}
      >
        <ModelAssignments />
      </SettingsSection>
      <ModelUpdateSettings />
      <ModelDiagnostics />
      <CollapsibleSection title="Automatic enrichment" description={<>Generate <strong>term previews</strong> and find <strong>free images</strong> in the background.</>}>
        <p className="field-help">These tasks use the <strong>secondary tasks model</strong> and may incur provider charges.</p>
        <SettingsToggle title="Generate term previews automatically" checked={autoTermPreviews} onChange={setAutoTermPreviews}
          description={<>Generate <strong>one-sentence explanations</strong> for marked terms. When off, hovering only previews a <strong>linked node</strong>, if one exists.</>} />
        <SettingsToggle title="Search for free images automatically" checked={autoFreeImages} onChange={setAutoFreeImages}
          description={<>Find <strong>freely reusable images</strong> from <strong>Wikimedia Commons</strong> and <strong>Openverse</strong> for <strong>encyclopedic and answer nodes</strong>. Use <strong>Search for free images</strong> in a node’s panel to search manually.</>} />
      </CollapsibleSection>
      <CollapsibleSection title="Generation token limits" description={<>Control the <strong>reasoning and output allowance</strong> for model requests.</>}>
        <GenerationTokenLimits />
      </CollapsibleSection>
    </>
  );
}

function ChatSettings() {
  const instructions = useSettingsStore((state) => state.normalChatInstructions ?? '');
  const setInstructions = useSettingsStore((state) => state.setNormalChatInstructions);
  const defaultChunking = useSettingsStore(s => s.defaultChatInformationChunking);
  const setDefaultChunking = useSettingsStore(s => s.setDefaultChatInformationChunking);
  return (
    <SettingsSection title="Chat">
      <label className="field-label" htmlFor="normal-chat-instructions"><strong>Normal chat instructions</strong></label>
      <p className="field-help" id="normal-chat-instructions-help">Applies to <strong>new and regenerated chat answers</strong> when <strong>Information chunking is off</strong>.</p>
      <textarea
        id="normal-chat-instructions"
        aria-describedby="normal-chat-instructions-help"
        className="input settings-instructions"
        rows={4}
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        placeholder="For example: keep answers concise, explain unfamiliar ideas, and use concrete examples…"
      />
      <SettingsToggle title="Information chunking by default" checked={defaultChunking} onChange={setDefaultChunking}
        description={<>Ask for <strong>one idea per sentence</strong>, clear line breaks, <strong>bold key ideas</strong>, and headings or bullets when useful. This sets the starting mode for <strong>new chats only</strong>. Each chat’s panel can change it for new and regenerated answers.</>} />
    </SettingsSection>
  );
}

function PromptsTab() {
  return (
    <>
      <SettingsSection
        title="System prompts"
        description={<>Edit the app’s <strong>system instructions and task templates</strong> for conversations, nodes, previews, images, sources, and background tasks. Changes apply to <strong>future requests</strong>. Existing content stays unchanged.</>}
      >
        <div className="settings-callout"><p><strong>Custom system prompts can break generation.</strong> App updates overwrite a customized prompt when its built-in default changes. Imports and sync follow the same rule. <strong>No saved versions or recovery copies are kept.</strong> Normal chat instructions are not affected.</p></div>
        <PromptsEditor />
      </SettingsSection>
    </>
  );
}

/* ---- Canvas tab ---- */
function CanvasTab() {
  const followUpEnterSends = useSettingsStore((s) => s.followUpEnterSends);
  const setFollowUpEnterSends = useSettingsStore((s) => s.setFollowUpEnterSends);

  return (
    <>
      <ChatSettings />
      <SettingsSection title="Writing" description={<>Choose how <strong>Enter</strong> works in chat and node follow-up fields.</>}>
        <div className="field-row" style={{ marginTop: 16 }}>
          <label className="field-label" htmlFor="settings-enter">
            Enter key
          </label>
          <select
            id="settings-enter"
            className="input"
            value={followUpEnterSends ? 'send' : 'newline'}
            onChange={(e) => setFollowUpEnterSends(e.target.value === 'send')}
          >
            <option value="send">sends the follow-up (Shift or Ctrl/&#8984;+Enter = new line)</option>
            <option value="newline">makes a new line (Ctrl/&#8984;+Enter sends)</option>
          </select>
        </div>
        <p className="field-help">
          <strong>Shift+Enter</strong> always inserts a new line.
          <strong> Ctrl/⌘+Enter</strong> inserts a new line when Enter sends, or sends when Enter inserts a new line.
        </p>
      </SettingsSection>
      <SelectionWebSearchSettings />
      <CameraSettings />
    </>
  );
}

function ReadingSettings() {
  const language = useSettingsStore((s) => s.generationLanguage);
  const info = languageInfo(language);
  const typography = useReadingTypography(language, info.sample + (info.id === 'en' ? ' Sākya Muni' : ''));
  const sentencePerLine = useSettingsStore((s) => s.sentencePerLine);
  const setSentencePerLine = useSettingsStore((s) => s.setSentencePerLine);
  const justifyParagraph = useSettingsStore((s) => s.justifyParagraph);
  const setJustifyParagraph = useSettingsStore((s) => s.setJustifyParagraph);

  return (
    <SettingsSection title="Reading">
      <NodeFontSettings />
      <div className="settings-paragraph-layout" role="group" aria-labelledby="settings-paragraph-layout-heading" aria-describedby="settings-paragraph-layout-scope">
        <div className="settings-reading-subheading">
          <h4 id="settings-paragraph-layout-heading">Paragraph layout</h4>
          <p id="settings-paragraph-layout-scope">For <strong>encyclopedic and explain nodes</strong>.</p>
        </div>
        <SettingsToggle
          title="One sentence per line"
          description={<>Start each sentence on a <strong>new line</strong>. Wrapped lines are <strong>indented with guide marks</strong> to make sentence boundaries clear.</>}
          checked={sentencePerLine}
          onChange={setSentencePerLine}
        />
        <SettingsToggle
          title="Justify the opening paragraph"
          description={<>Align text to <strong>both edges</strong>. Works with either sentence-line setting.</>}
          checked={justifyParagraph}
          onChange={setJustifyParagraph}
        />
      </div>
      <div className="settings-reading-preview" aria-label="Node text preview">
        <span className="settings-eyebrow">Reading preview · {info.name}</span>
        <div
          style={typography} lang={info.locale} dir={languageDirection(language)}
        >
          {info.id !== 'en' ? <p style={{ textAlign: justifyParagraph ? 'justify' : 'start' }}>
            <span className={sentencePerLine ? 'sc-ab-sentence' : undefined}>{info.sample}</span>
          </p> : <>
          <h4>Ignorance and suffering</h4>
          <p style={{ textAlign: justifyParagraph ? 'justify' : 'left' }}>
            <span className={sentencePerLine ? 'sc-ab-sentence' : undefined}>
              Sākya Muni taught that <strong>ignorance produces desire</strong>,{' '}
              <strong>unsatisfied desire is the cause of rebirth</strong>, and rebirth,{' '}
              <strong>the cause of sorrow</strong>.{' '}
            </span>
            <span className={sentencePerLine ? 'sc-ab-sentence' : undefined}>
              To get rid of sorrow, therefore, it is necessary to <strong>escape rebirth</strong>; to escape
              rebirth, it is necessary to <strong>extinguish desire</strong>; and to extinguish desire, it
              is necessary to <strong>destroy ignorance</strong>.
            </span>
          </p>
          <p className="settings-reading-citation">
            H. S. Olcott,{' '}
            <a
              href="https://www.gutenberg.org/files/30216/30216-h/30216-h.htm"
              target="_blank"
              rel="noreferrer"
            >
              The Buddhist Catechism
            </a>
            , “Fundamental Buddhistic Beliefs”, V. Original wording; emphasis added.
          </p>
          </>}
        </div>
      </div>
    </SettingsSection>
  );
}

function GroupColorSettings() {
  const groupColorAssignment = useSettingsStore((s) => s.groupColorAssignment);
  const setGroupColorAssignment = useSettingsStore((s) => s.setGroupColorAssignment);
  const [reassigningColors, setReassigningColors] = useState(false);

  const reassignColors = async () => {
    if (reassigningColors) return;
    setReassigningColors(true);
    try {
      await reassignActiveProjectColors(groupColorAssignment);
    } finally {
      setReassigningColors(false);
    }
  };

  return (
    <SettingsSection
      title="Group colors"
      description={<>Choose how <strong>new groups</strong> receive colors.</>}
    >
      <div className="field-row">
        <label className="field-label" htmlFor="group-color-assignment">
          Automatic assignment
        </label>
        <select
          id="group-color-assignment"
          className="input"
          value={groupColorAssignment}
          onChange={(event) => setGroupColorAssignment(event.target.value as GroupColorAssignment)}
        >
          <option value="opposites">Opposites</option>
          <option value="golden-angle">Golden angle</option>
          <option value="hierarchy-aware">Hierarchy-aware</option>
        </select>
      </div>
      <p className="field-help" style={{ marginBottom: 12 }}>
        <strong>Opposites</strong> repeatedly divides the color wheel in half.
        <strong> Golden angle</strong> advances each new color by 137.5°.
        Neither sequence rewinds when groups are recolored or deleted.
        <strong> Hierarchy-aware</strong> gives related branches similar colors.
        This setting affects <strong>future groups only</strong>.
      </p>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={reassigningColors}
        onClick={() => void reassignColors()}
      >
        {reassigningColors ? 'Reassigning…' : 'Reassign current project colors'}
      </button>
      <p className="field-help">
        Rebuilds project&apos;s <strong>group colors from scratch</strong>.
        Sequence modes follow the <strong>current sidebar order</strong>.
        Hierarchy-aware reconstructs parent families before their descendants.
        The change <strong>can be undone</strong>.
      </p>
    </SettingsSection>
  );
}

/* ---- Theme tab ---- */
function ThemeTab() {
  const [theme, setThemeState] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const accentHueShift = useSettingsStore((s) => s.accentHueShift);
  const setAccentHueShift = useSettingsStore((s) => s.setAccentHueShift);
  const accentDesaturate = useSettingsStore((s) => s.accentDesaturate);
  const setAccentDesaturate = useSettingsStore((s) => s.setAccentDesaturate);
  const accentDarken = useSettingsStore((s) => s.accentDarken);
  const setAccentDarken = useSettingsStore((s) => s.setAccentDarken);

  useEffect(() => {
    setThemeState(readThemePreference());
    const synchronize = (event: Event) => {
      setThemeState((event as CustomEvent<ThemeChangeDetail>).detail.preference);
    };
    window.addEventListener(THEME_CHANGE_EVENT, synchronize);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, synchronize);
  }, []);

  const applyTheme = (t: ThemePreference) => {
    setThemeState(t);
    applyThemePreference(t);
  };

  return (
    <>
      <SettingsSection
        title="Color theme"
        description={<>Use a <strong>light or dark theme</strong>. <strong>System</strong> follows your device’s appearance.</>}
      >
        <div className="settings-theme-options" role="group" aria-label="Theme">
          {(
            [
              { id: 'light', label: 'Light', icon: Sun },
              { id: 'dark', label: 'Dark', icon: Moon },
              { id: 'system', label: 'System', icon: Monitor },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`settings-theme-option${theme === id ? ' is-selected' : ''}`}
              aria-pressed={theme === id}
              onClick={() => applyTheme(id)}
            >
              <span className={`settings-theme-sample settings-theme-sample--${id}`} aria-hidden="true">
                <i />
                <span>
                  <b />
                  <b />
                  <b />
                </span>
              </span>
              <span className="settings-theme-caption">
                <Icon size={15} />
                {label}
                {theme === id && <Check size={14} />}
              </span>
            </button>
          ))}
        </div>
      </SettingsSection>
      <ReadingSettings />
      <SettingsSection
        title="Canvas accents"
        description={<>Adjust <strong>arrows and resize handles</strong> relative to each node’s group color. <strong>Ungrouped nodes</strong> stay neutral.</>}
      >
        <AccentSettingRow
          label="Hue shift"
          value={accentHueShift}
          def={DEFAULT_SETTINGS.accentHueShift}
          min={0}
          max={180}
          unit="°"
          signed
          onChange={setAccentHueShift}
        />
        <AccentSettingRow
          label="Saturation"
          value={-accentDesaturate}
          def={-DEFAULT_SETTINGS.accentDesaturate}
          min={-100}
          max={100}
          unit="%"
          onChange={(value) => setAccentDesaturate(-value)}
        />
        <AccentSettingRow
          label="Brightness"
          value={-accentDarken}
          def={-DEFAULT_SETTINGS.accentDarken}
          min={-100}
          max={100}
          unit="%"
          onChange={(value) => setAccentDarken(-value)}
        />
        <p className="field-help">
          <strong>0 leaves saturation or brightness unchanged</strong>. Move saturation left for muted colors or right for vivid colors.
          Move brightness left for darker accents or right for brighter accents. Dark mode keeps a <strong>minimum contrast</strong> for visibility.
        </p>
      </SettingsSection>
      <GroupColorSettings />
    </>
  );
}

/** A compact accent control: a +/- direction toggle for signed values,
 *  a slider, a 3-digit number field that mirrors it, a unit, and a reset to the
 *  default. The slider updates LOCAL state on drag (so the thumb is perfectly
 *  smooth with ZERO canvas work) and only commits — recoloring every node and
 *  arrow — when the drag ENDS (pointer/key up). The number field accepts an
 *  empty value while editing and falls back to the minimum on blur. */
function AccentSettingRow({
  label,
  value,
  def,
  min,
  max,
  unit,
  signed = false,
  onChange,
}: {
  label: string;
  value: number;
  def: number;
  min: number;
  max: number;
  unit: string;
  signed?: boolean;
  onChange: (v: number) => void;
}) {
  const [mag, setMag] = useState(signed ? Math.abs(value) : value);
  const [neg, setNeg] = useState(value < 0);
  const [text, setText] = useState(String(signed ? Math.abs(value) : value));
  // Mirror of `mag` for the release handlers (avoids reading stale state).
  const magRef = useRef(signed ? Math.abs(value) : value);
  useEffect(() => {
    const next = signed ? Math.abs(value) : value;
    magRef.current = next;
    setMag(next);
    setText(String(next));
    setNeg(value < 0);
  }, [value, signed]);

  const clampMag = (m: number) => Math.max(min, Math.min(max, m));
  const commit = (m: number, n: boolean) => onChange(signed && n ? -m : m);
  const setMagBoth = (m: number) => {
    magRef.current = m;
    setMag(m);
    if (!signed) setNeg(m < 0);
  };
  const slide = (m: number) => {
    setMagBoth(m);
    setText(String(m));
  }; // drag = LOCAL only
  const setDir = (n: boolean) => {
    const next = signed ? magRef.current : (n ? -1 : 1) * Math.abs(magRef.current);
    if (!signed) slide(next);
    setNeg(n);
    commit(next, n);
  };
  const reset = () => {
    const m = signed ? Math.abs(def) : def;
    setMagBoth(m);
    setNeg(def < 0);
    setText(String(m));
    commit(m, def < 0);
  };

  return (
    <div className="field-row">
      <label className="field-label">{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Fixed-width slot so sliders line up whether or not a row has a toggle. */}
        <div style={{ width: 48, flexShrink: 0 }}>
          {(signed || min < 0) && (
            <div className="accent-dir-toggle">
              <button
                type="button"
                className={!neg ? 'on' : ''}
                onClick={() => setDir(false)}
                title={`${label}: positive (+)`}
                aria-label={`${label}: positive (+)`}
                aria-pressed={!neg}
              >
                +
              </button>
              <button
                type="button"
                className={neg ? 'on' : ''}
                onClick={() => setDir(true)}
                title={`${label}: negative (−)`}
                aria-label={`${label}: negative (−)`}
                aria-pressed={neg}
              >
                −
              </button>
            </div>
          )}
        </div>
        <span className={min < 0 ? 'accent-centered-range' : undefined}>
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={1}
          value={mag}
          onChange={(e) => slide(clampMag(Number(e.target.value)))}
          onPointerUp={() => commit(magRef.current, neg)}
          onKeyUp={() => commit(magRef.current, neg)}
          style={{ width: 104, flexShrink: 0 }}
        />
        {min < 0 && <span className="accent-zero-mark" aria-hidden="true">0</span>}
        </span>
        <input
          type="number"
          aria-label={`${label} value`}
          className="input accent-num"
          min={min}
          max={max}
          value={text}
          onChange={(e) => {
            const raw = e.target.value;
            setText(raw); // allow an empty field while editing
            if (raw === '') return;
            const n = Number(raw);
            if (Number.isNaN(n)) return;
            const m = clampMag(n);
            setMagBoth(m);
            commit(m, neg);
          }}
          onBlur={() => {
            if (text === '' || Number.isNaN(Number(text))) {
              setMagBoth(min);
              setText(String(min));
              commit(min, neg); // left empty → minimum
            } else {
              setText(String(mag)); // normalise to the clamped value
            }
          }}
          style={{ width: 54, flexShrink: 0 }}
        />
        <span className="field-value" style={{ width: 10, color: 'var(--subtext0)' }}>
          {unit}
        </span>
        <button
          type="button"
          className="shortcut-action-btn"
          onClick={reset}
          title="Reset to default"
          aria-label={`Reset ${label} to default`}
        >
          <RotateCcw size={14} />
        </button>
      </div>
    </div>
  );
}

/* ---- Shortcuts tab ---- */
function ShortcutsTab() {
  const overrides = useSettingsStore((s) => s.keybindings);
  const setActionBindings = useSettingsStore((s) => s.setActionBindings);
  const resetKeybinding = useSettingsStore((s) => s.resetKeybinding);
  const resetAllKeybindings = useSettingsStore((s) => s.resetAllKeybindings);
  // The (action, slot) currently capturing a new combo (null = none). `slot`
  // is the binding index to write — an existing slot to edit, or the next
  // index to add an alternative.
  const [arming, setArming] = useState<{ id: string; slot: number } | null>(null);
  // Inline note under the row being rebound (conflict / reserved warning).
  const [notice, setNotice] = useState<{ id: string; text: string; warn?: boolean } | null>(null);
  const [filter, setFilter] = useState('');

  // While arming, capture the NEXT keystroke (capture phase + stopPropagation
  // so it doesn't also trigger the live app shortcut or close the modal).
  useEffect(() => {
    if (!arming) return;
    const { id, slot } = arming;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setArming(null);
        return;
      }
      const b = bindingFromEvent(e);
      if (!b) return; // a bare modifier — keep waiting for the real key
      const conflict = findAppConflict(b, id, overrides);
      if (conflict) {
        setNotice({ id, text: `Already used by "${conflict}" — try another`, warn: true });
        setArming(null);
        return;
      }
      const cur = resolveBindings(id, overrides);
      const next = slot >= cur.length ? [...cur, b] : cur.map((x, i) => (i === slot ? b : x));
      // Collapse a duplicate (e.g. both slots set to the same combo).
      const deduped = next.filter((x, i, arr) => arr.findIndex((y) => bindingsEqual(x, y)) === i);
      setActionBindings(id, deduped);
      setNotice(
        isBrowserReserved(b)
          ? { id, text: `Set — your browser may intercept ${bindingToGlyph(b)}`, warn: true }
          : null,
      );
      setArming(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [arming, overrides, setActionBindings]);

  const removeBinding = (id: string, slot: number) => {
    const cur = resolveBindings(id, overrides);
    setActionBindings(
      id,
      cur.filter((_, i) => i !== slot),
    );
    if (notice?.id === id) setNotice(null);
  };

  const hasOverrides = !!overrides && Object.keys(overrides).length > 0;
  const matchingActions = KEY_ACTIONS.filter((action) =>
    `${action.label} ${actionGlyph(action.id, overrides)}`
      .toLocaleLowerCase()
      .includes(filter.toLocaleLowerCase()),
  );

  return (
    <>
      <input
        className="input settings-model-search"
        type="search"
        aria-label="Find a shortcut"
        placeholder="Find a shortcut…"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <p className="field-help">
        Choose the <strong>pencil</strong> to replace a shortcut, or <strong>+ alt</strong> to add a second one.
        Then press the new key combination. <strong>Esc</strong> cancels recording.
      </p>
      <table className="shortcut-table shortcut-grid settings-shortcuts" aria-label="Canvas and app shortcuts">
        <tbody>
          {matchingActions.map((a, index) => {
            const overridden = !!overrides?.[a.id];
            const bindings = resolveBindings(a.id, overrides);
            // Render one binding as an editable pill (glyph + pencil, plus a
            // remove ✕ when the action has two bindings).
            const pill = (b: KeyBinding, i: number) => {
              const armed = arming?.id === a.id && arming.slot === i;
              return (
                <span className={'kbd-pill' + (armed ? ' armed' : '')}>
                  <span className="kbd-pill-glyph">{armed ? 'Press keys…' : bindingToGlyph(b)}</span>
                  <button
                    type="button"
                    className="kbd-pill-btn"
                    onClick={() => {
                      setNotice(null);
                      setArming(armed ? null : { id: a.id, slot: i });
                    }}
                    title="Change this shortcut"
                    aria-label={`Change ${a.label} shortcut`}
                  >
                    <Pencil size={14} />
                  </button>
                  {bindings.length > 1 && (
                    <button
                      type="button"
                      className="kbd-pill-btn"
                      onClick={() => removeBinding(a.id, i)}
                      title="Remove this shortcut"
                      aria-label={`Remove this ${a.label} shortcut`}
                    >
                      <X size={14} />
                    </button>
                  )}
                </span>
              );
            };
            return (
              <Fragment key={a.id}>
                {(index === 0 || matchingActions[index - 1]?.rebindable !== a.rebindable) && (
                  <tr className="settings-shortcut-group">
                    <th colSpan={4}>{a.rebindable ? 'Customizable shortcuts' : 'Canvas gestures'}</th>
                  </tr>
                )}
                <tr className="settings-shortcut-row">
                  <td className="shortcut-label">
                    {a.label}
                    {a.shiftForDirection && (
                      <span style={{ color: 'var(--overlay0)' }}> (Shift = previous)</span>
                    )}
                  </td>
                  {a.rebindable ? (
                    <>
                      {/* Col 2 — primary shortcut */}
                      <td className="shortcut-cell">{bindings[0] && pill(bindings[0], 0)}</td>
                      {/* Col 3 — second shortcut, or the add-alternative button */}
                      <td className="shortcut-cell">
                        {bindings.length === 2
                          ? pill(bindings[1]!, 1)
                          : bindings.length < MAX_BINDINGS && (
                              <button
                                type="button"
                                className={`shortcut-action-btn${arming?.id === a.id && arming.slot === bindings.length ? ' kbd-pill armed' : ''}`}
                                onClick={() => {
                                  setNotice(null);
                                  setArming(
                                    arming?.id === a.id && arming.slot === bindings.length
                                      ? null
                                      : { id: a.id, slot: bindings.length },
                                  );
                                }}
                                title="Add an alternative shortcut"
                                aria-label={`Add alternative for ${a.label}`}
                              >
                                {arming?.id === a.id && arming.slot === bindings.length ? (
                                  'Press keys…'
                                ) : (
                                  <>
                                    <Plus size={14} /> alt
                                  </>
                                )}
                              </button>
                            )}
                      </td>
                      {/* Col 4 — revert to default (when changed) */}
                      <td className="shortcut-cell">
                        {overridden && (
                          <button
                            type="button"
                            className="shortcut-action-btn"
                            onClick={() => {
                              resetKeybinding(a.id);
                              if (notice?.id === a.id) setNotice(null);
                            }}
                            title="Reset to default"
                            aria-label={`Reset ${a.label} to default`}
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                      </td>
                    </>
                  ) : (
                    <td className="shortcut-cell" colSpan={3}>
                      <span className="kbd">{actionGlyph(a.id, overrides)}</span>
                    </td>
                  )}
                </tr>
                {notice?.id === a.id && (
                  <tr>
                    <td />
                    <td
                      colSpan={3}
                      className="shortcut-notice"
                      style={{ color: notice.warn ? '#b4690e' : 'var(--subtext0)' }}
                    >
                      {notice.text}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {hasOverrides && (
            <tr>
              <td className="shortcut-label">
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ marginTop: 4 }}
                  onClick={() => {
                    resetAllKeybindings();
                    setNotice(null);
                    setArming(null);
                  }}
                >
                  Reset all to defaults
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <h3 className="settings-context-shortcuts-heading">Contextual shortcuts</h3>
      <p className="field-help">These <strong>fixed shortcuts</strong> work only in the named view or interaction. Typing in a field keeps its normal text-editing keys.</p>
      <table className="shortcut-table settings-shortcuts" aria-label="Contextual shortcuts">
        <tbody>{CONTEXT_SHORTCUTS.filter(item => `${item.group} ${item.label} ${item.keys}`.toLowerCase().includes(filter.toLowerCase())).map(item => (
          <tr key={item.id} className="settings-shortcut-row">
            <td className="shortcut-label"><strong>{item.group}</strong><br />{item.label}</td>
            <td className="shortcut-cell"><span className="kbd">{item.keys}</span></td>
          </tr>
        ))}</tbody>
      </table>
      {matchingActions.length === 0 && !CONTEXT_SHORTCUTS.some(item => `${item.group} ${item.label} ${item.keys}`.toLowerCase().includes(filter.toLowerCase())) && <p className="field-help">No shortcuts match “{filter}”.</p>}
      <div className="settings-footnote">
        <CollapsibleSection title="About browser-reserved shortcuts">
          <p className="field-help">
            Some combinations—{bindingToGlyph({ key: 't', meta: true })},{' '}
            {bindingToGlyph({ key: 'w', meta: true })}, {bindingToGlyph({ key: 'r', meta: true })}, F5, F11,
            and similar—are <strong>reserved by your browser</strong> and may not reach the app.
          </p>
        </CollapsibleSection>
      </div>
    </>
  );
}

/* ---- Data tab ---- */
function DataTab({ onClose }: { onClose: () => void }) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const settingsImportInputRef = useRef<HTMLInputElement>(null);

  /** Download the currently open project as a self-contained .scatter.zip. */
  const exportProject = async () => {
    try {
      const out = await exportActiveScatterZip();
      if (out) downloadBlob(out.blob, out.filename);
    } catch (e) {
      console.error('[scatter] export failed:', e);
      window.alert('Export failed — see the browser console for details.');
    }
  };

  /** Import a picked .scatter.zip as a new project and switch to it. */
  const importProjectFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    try {
      await importScatterFromFile(file);
      onClose(); // reveal the newly active project
    } catch (err) {
      console.error('[scatter] import failed:', err);
      window.alert(
        err instanceof ProjectImportError
          ? err.message
          : 'Import failed — that file doesn’t look like a Scatter project export.',
      );
    }
  };

  const exportSettings = async (includeSecrets = true) => {
    try {
      await useSyncStore.getState().hydrate();
      const out = createSettingsExport(useSettingsStore.getState(), undefined, undefined, undefined, {
        includeSecrets,
      });
      downloadBlob(out.blob, out.filename);
    } catch (error) {
      console.error('[scatter] settings export failed:', error);
      window.alert('Settings export failed — see the browser console for details.');
    }
  };

  const importSettingsFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const imported = await parseSettingsFile(file);
      const confirmed = window.confirm(
        'Replace the current settings, provider API keys, and any synchronization connection included in this file?\n\n' +
          'Google Drive requires connecting if this browser is not already authorized. Projects and their media will not be changed by the import.',
      );
      if (!confirmed) return;
      await applySettingsImport(imported);
      applySettingsUiPreferences(imported.uiPreferences);
      onClose();
      window.location.reload();
    } catch (error) {
      console.error('[scatter] settings import failed:', error);
      window.alert(
        error instanceof SettingsImportError
          ? error.message
          : 'Settings could not be restored on this device. Please try again.',
      );
    }
  };

  const eraseProject = async () => {
    const ok = window.confirm(
      'Erase all locally saved project data from this browser? Your API keys and settings will be kept. Export any projects you want to keep first. This cannot be undone.',
    );
    if (!ok) return;
    try {
      const root = await navigator.storage?.getDirectory?.();
      if (root) {
        // @ts-expect-error 'entries' is supported in modern browsers
        for await (const [name] of root.entries()) {
          if (name === 'settings.json') continue;
          try {
            await root.removeEntry(name, { recursive: true });
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      console.error('[scatter] erase failed:', e);
    }
    onClose();
    window.location.reload();
  };

  /** Nuke EVERYTHING this app stored on the device — all OPFS files (projects +
   *  settings.json) and all localStorage (theme, etc.) — then reload. With no
   *  saved provider/settings, the app comes back up on the onboarding screen. */
  const wipeAllData = async () => {
    const ok = window.confirm(
      'Remove ALL app data from this device?\n\nThis erases every project, your API keys, and all settings, then restarts the app at onboarding. This cannot be undone.',
    );
    if (!ok) return;
    try {
      const root = await navigator.storage?.getDirectory?.();
      if (root) {
        // @ts-expect-error 'entries' is supported in modern browsers
        for await (const [name] of root.entries()) {
          try {
            await root.removeEntry(name, { recursive: true });
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      console.error('[scatter] wipe (OPFS) failed:', e);
    }
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
    onClose();
    window.location.reload();
  };

  return (
    <>
      <SettingsSection
        title="Project backups"
        description={<>Export the <strong>open project and its media</strong> as a .scatter.zip file. Import adds a backup as a <strong>new project</strong>.</>}
      >
        <div className="field-row">
          <label className="field-label">Project</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-secondary" onClick={() => void exportProject()}>
              <Upload size={14} /> Export project
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => importInputRef.current?.click()}
            >
              <Download size={14} /> Import project
            </button>
          </div>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: 'none' }}
          onChange={(e) => void importProjectFile(e)}
        />
      </SettingsSection>
      <SettingsSection
        title="Settings backup"
        description={<>Save your <strong>preferences and provider configuration</strong> in a file. Import it to restore settings or move them to <strong>another browser</strong>.</>}
      >
        <div className="field-row" style={{ marginTop: 16 }}>
          <label className="field-label">Settings</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-secondary" onClick={() => void exportSettings()}>
              <Upload size={14} /> Export settings
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void exportSettings(false)}>
              <Upload size={14} /> Export without keys or passwords
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => settingsImportInputRef.current?.click()}
            >
              <Download size={14} /> Import settings
            </button>
          </div>
        </div>
        <input
          ref={settingsImportInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(event) => void importSettingsFile(event)}
        />
        <p className="field-help settings-key-warning">
          A <strong>full export includes API keys and any WebDAV app password</strong>.
          WebDAV connects the app to your own file-storage server, such as Nextcloud.{' '}
          <strong>Keep full exports private</strong>: their credentials allow access to your accounts.{' '}
          <strong>Export without keys or passwords</strong> excludes these credentials.
          Reconnect your accounts after importing a credential-free file.
          Google Drive authorization is <strong>never exported</strong>.
        </p>
        <p className="field-help">
          Both exports include <strong>current custom prompts and developer settings</strong>.
          Outdated advanced overrides reset to current defaults on import; overrides without a verifiable defaults identifier reset too. <strong>Saved prompt and developer-setting versions are not included.</strong>{' '}
          <strong>Explored topics and chat-starter history are excluded.</strong>{' '}
          <strong>Custom font files</strong> are embedded in both exports.{' '}
          Project content, conversations inside nodes, and cloud snapshot history are excluded.
          Use a <strong>project backup</strong> to save project content.
          Credential-free settings files can still contain personal prompts and server addresses.
        </p>
      </SettingsSection>
      <SettingsSection
        title="Remove local data"
        description={<>These actions <strong>cannot be undone</strong>. Export a <strong>backup</strong> first.</>}
        className="settings-danger-zone"
      >
        <div className="field-row">
          <span className="field-label">Project data</span>
          <button
            type="button"
            className="btn btn-secondary settings-danger-action"
            onClick={() => void eraseProject()}
          >
            <Trash2 size={14} /> Erase project data
          </button>
        </div>
        <p className="field-help">
          Removes <strong>saved project data</strong> from this browser. <strong>Provider keys and settings</strong> are kept.
        </p>
        <div className="field-row">
          <label className="field-label">Everything</label>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void wipeAllData()}
            style={{ color: 'var(--red)' }}
          >
            <Trash2 size={12} /> Remove all app data
          </button>
        </div>
        <p className="field-help">
          Deletes <strong>every project, API key, and setting</strong> stored on this device.
          The app then restarts at onboarding. This <strong>cannot be undone</strong>.
        </p>
      </SettingsSection>
    </>
  );
}

/* ---- Dev tab ---- */
function DevTab({ onClose }: { onClose: () => void }) {
  const activeProject = useGraphStore((s) => s.project);
  const setForceWelcomeA = useSettingsStore((s) => s.setForceWelcomeA);
  const pixelRulerMode = useSettingsStore((s) => s.pixelRulerMode);
  const setPixelRulerMode = useSettingsStore((s) => s.setPixelRulerMode);
  const simulateWebglFailure = useSettingsStore((s) => s.simulateWebglFailure);
  const setSimulateWebglFailure = useSettingsStore((s) => s.setSimulateWebglFailure);

  const backToStartScreen = () => {
    // Non-destructive: just opens the welcome screen with current settings
    // pre-filled. The user can change provider/key or use "Return to app"
    // to return to the canvas.
    setForceWelcomeA(true);
    onClose();
  };

  const testGoogleDriveRenewalFailure = () => {
    simulateGoogleDriveRenewalFailure();
    onClose();
  };

  const testVersionConflict = () => {
    if (simulateRemoteProjectUpdateConflict()) onClose();
  };

  return (
    <>
      {/* Each part of the dev tab is collapsed by default and expandable. */}
      <div className="settings-callout">
        <SlidersHorizontal size={18} />
        <p>Adjust <strong>layout behavior</strong> and test <strong>app recovery flows</strong>.</p>
      </div>
      <div className="settings-callout"><p><strong>Developer overrides can break layout or performance.</strong> App updates reset a settings group when its built-in defaults or allowed ranges change. Imports and sync follow the same rule. <strong>No saved versions or recovery copies are kept.</strong></p></div>
      <div className="settings-dev-sections">
        <CollapsibleSection title="Physics" description={<>Controls <strong>node spacing and motion</strong>, and <strong>arrow paths</strong>.</>}>
          <PhysicsSliders />
        </CollapsibleSection>
        <CollapsibleSection
          title="Bullet sizing"
          description={<>Controls how <strong>bullets expand and collapse</strong> to fit inside nodes.</>}
        >
          <BulletSizingSliders />
        </CollapsibleSection>
        <CollapsibleSection
          title="Developer options"
          description={<>Test <strong>welcome screens, sync recovery, and rendering</strong>.</>}
        >
          <p className="field-help" style={{ marginBottom: 18, marginTop: 4 }}>
            These tools test app behavior <strong>without clearing browser storage</strong>.
          </p>

          <div className="field-row">
            <label className="field-label">Promotional screenshots</label>
            <button type="button" className="btn btn-secondary" onClick={() => { useScreenshotStore.getState().setOpen(true); onClose(); }}>
              <Monitor size={14} /> Open screenshot tool
            </button>
          </div>
          <p className="field-help" style={{ marginBottom: 16 }}>
            Render the whole app or a selected area at <strong>2560 px on the longer edge</strong>.
            Text and vector graphics are redrawn, not enlarged from a screen capture. Raster images retain their original source detail.
            Unsupported canvases or external embeds are reported before saving.
          </p>

          <div className="field-row">
            <label className="field-label">Google Drive renewal</label>
            <button type="button" className="btn btn-secondary" onClick={testGoogleDriveRenewalFailure}>
              <CloudOff size={12} /> Trigger renewal failure
            </button>
          </div>
          <p className="field-help" style={{ marginBottom: 16 }}>
            Opens the <strong>reconnection dialog</strong> without changing the saved token.
            Its <strong>Reconnect</strong> button uses real Google authorization.
          </p>

          <div className="field-row">
            <label className="field-label">Sync conflict</label>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!activeProject}
              onClick={testVersionConflict}
              data-tip={activeProject ? 'Preview the synchronized-version choice' : 'Open a project first'}
            >
              <CloudDownload size={12} /> Show version conflict
            </button>
          </div>
          <p className="field-help" style={{ marginBottom: 16 }}>
            Previews the <strong>sync-conflict window</strong>.
            Choosing either version only closes the preview.{' '}
            <strong>No provider request or project change</strong> is made.
          </p>

          <div className="field-row">
            <label className="field-label">Start screen</label>
            <button type="button" className="btn btn-secondary" onClick={backToStartScreen}>
              <Home size={12} /> Back to start screen
            </button>
          </div>
          <p className="field-help" style={{ marginBottom: 16 }}>
            Reopens <strong>onboarding</strong> with your saved provider, key, and model.
            Choose <strong>Return to app</strong> to return to the canvas.
          </p>

          <div className="field-row">
            <label className="field-label">Pixel ruler</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['off', 'viewport', 'canvas'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={pixelRulerMode === m ? 'btn btn-primary' : 'btn btn-secondary'}
                  onClick={() => setPixelRulerMode(m)}
                  style={{ padding: '0 12px', height: 30, fontSize: 12, textTransform: 'capitalize' }}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <p className="field-help">
            Draws a grid with <strong>100 px major lines</strong> and 10 px minor lines.
            <strong> Viewport</strong> measures browser-window pixels, independent of canvas zoom.
            <strong> Canvas</strong> measures canvas pixels and moves with the project.
          </p>

          <div className="field-row">
            <label className="field-label">Simulate WebGL failure</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {(
                [
                  ['off', false],
                  ['on', true],
                ] as const
              ).map(([text, val]) => (
                <button
                  key={text}
                  type="button"
                  className={simulateWebglFailure === val ? 'btn btn-primary' : 'btn btn-secondary'}
                  onClick={() => setSimulateWebglFailure(val)}
                  style={{ padding: '0 12px', height: 30, fontSize: 12, textTransform: 'capitalize' }}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
          <p className="field-help">
            Simulates <strong>unavailable WebGL2</strong> to show the background-failure notice.
            This test <strong>resets on reload</strong>.
          </p>
        </CollapsibleSection>
      </div>
    </>
  );
}

/* ---- Main modal ---- */
const SETTINGS_ICONS: Record<Tab, LucideIcon> = {
  theme: Palette,
  canvas: SlidersHorizontal,
  shortcuts: Keyboard,
  providers: Network,
  openrouter: Cloud,
  models: Sparkles,
  prompts: FileText,
  sync: Cloud,
  data: Database,
  dev: Code,
};

export function SettingsModal({ open, onClose, initialPage }: Props) {
  const hasOpenRouter = useSettingsStore(s => s.providers.some(p => p.preset === 'openrouter' && !!p.apiKey.trim()));
  const [tab, setTab] = useState<Tab>(initialPage ?? 'theme');
  const [query, setQuery] = useState('');
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open || !initialPage) return;
    setTab(initialPage);
    setQuery('');
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [open, initialPage]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        if (query) {
          setQuery('');
          searchRef.current?.focus();
        } else onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const controls = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose, query]);

  if (!open) return null;

  const page = SETTINGS_PAGES.find((item) => item.id === tab)!;
  const searching = !!query.trim();
  const results = searchSettingsPages(query);
  const navigate = (id: Tab) => {
    setTab(id);
    setQuery('');
    if (paneRef.current) paneRef.current.scrollTop = 0;
    requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div
      ref={backdropRef}
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header settings-header">
          <div className="settings-title-block">
            <span className="modal-title">Settings</span>
            <span className="settings-autosave">
              <Check size={12} /> Changes save automatically
            </span>
          </div>
          <div className="settings-search">
            <Search size={16} />
            <input
              ref={searchRef}
              aria-label="Search settings"
              placeholder="Search settings…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                if (paneRef.current) paneRef.current.scrollTop = 0;
              }}
            />
            {query && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Clear settings search"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body settings-body">
          <nav className="settings-nav" aria-label="Settings categories">
            <div className="settings-nav-sections">
            {[...new Set(SETTINGS_PAGES.map((item) => item.group))].map((group) => (
              <div className="settings-nav-group" key={group}>
                <span className="settings-nav-group-title">{group}</span>
                {SETTINGS_PAGES.filter((item) => item.group === group).map((item) => {
                  const Icon = SETTINGS_ICONS[item.id];
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`settings-nav-item${tab === item.id && !searching ? ' active' : ''}`}
                      aria-current={tab === item.id && !searching ? 'page' : undefined}
                      disabled={item.id === 'openrouter' && !hasOpenRouter}
                      title={item.id === 'openrouter' && !hasOpenRouter ? 'Connect OpenRouter in AI providers' : undefined}
                      onClick={() => navigate(item.id)}
                    >
                      <Icon size={16} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            </div>
            <ReleaseFooter />
          </nav>

          <div ref={paneRef} className="modal-pane settings-pane" key={searching ? 'search' : tab}>
            <div className="settings-page-heading">
              <span className="settings-eyebrow">{searching ? 'Find your way' : page.group}</span>
              <h2 ref={headingRef} tabIndex={-1}>
                {searching ? 'Search settings' : page.label}
              </h2>
              <p>
                {searching
                  ? `${results.length} ${results.length === 1 ? 'category' : 'categories'} matching “${query.trim()}”`
                  : page.description}
              </p>
            </div>
            {searching ? (
              <div className="settings-search-results">
                {results.map((item) => {
                  const Icon = SETTINGS_ICONS[item.id];
                  return (
                    <button
                      type="button"
                      key={item.id}
                      aria-label={`Open ${item.label}`}
                      disabled={item.id === 'openrouter' && !hasOpenRouter}
                      onClick={() => navigate(item.id)}
                    >
                      <Icon size={20} />
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  );
                })}
                {results.length === 0 && (
                  <div className="settings-empty">
                    <Search size={28} />
                    <h3>No settings found</h3>
                    <p>Try a different word, such as “font”, “API key”, or “sync”.</p>
                  </div>
                )}
              </div>
            ) : (
              <>
                {tab === 'providers' && <ProvidersTab />}
                {tab === 'openrouter' && <OpenRouterAccount />}
                {tab === 'models' && <GenerationSection />}
                {tab === 'prompts' && <PromptsTab />}
                {tab === 'canvas' && <CanvasTab />}
                {tab === 'theme' && <ThemeTab />}
                {tab === 'shortcuts' && <ShortcutsTab />}
                {tab === 'sync' && <SyncDataSettings />}
                {tab === 'data' && <DataTab onClose={onClose} />}
                {tab === 'dev' && <DevTab onClose={onClose} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
