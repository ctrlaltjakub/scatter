import type { Settings } from './types';

/**
 * The one exhaustive inventory of persisted settings fields.
 *
 * `satisfies Record<keyof Settings, true>` deliberately makes adding a new
 * Settings field a compile error until it participates in persistence,
 * settings export, and settings import. This prevents the old failure mode
 * where useSettingsStore's hand-written snapshot silently forgot new fields.
 */
const SETTINGS_FIELDS = {
  generationLanguage: true,
  modelRecommendations: true,
  modelCompatibilityOverrides: true,
  providers: true,
  activeModelRef: true,
  mainModelOrder: true,
  secondaryModelRef: true,
  secondaryUseSameModel: true,
  interactiveModelRef: true,
  interactiveReasoningEffort: true,
  imageModelRef: true,
  imageGenerationSettings: true,
  webSearch: true,
  autoTermPreviews: true,
  autoFreeImages: true,
  syncApiKeys: true,
  cameraAutoPan: true,
  defaultChatInformationChunking: true,
  selectionWebSearch: true,
  openRouterRouting: true,
  sentencePerLine: true,
  nodeFontId: true,
  customNodeFonts: true,
  normalChatInstructions: true,
  justifyParagraph: true,
  followUpEnterSends: true,
  groupColorAssignment: true,
  accentHueShift: true,
  accentDesaturate: true,
  accentDarken: true,
  reasoningEffort: true,
  outputTokenCap: true,
  secondaryOutputTokenCap: true,
  interactiveOutputTokenCap: true,
  generationLimitsVersion: true,
  inputTokenCap: true,
  physicsConfig: true,
  bulletSizingConfig: true,
  customPrompts: true,
  advancedDefaults: true,
  customColors: true,
  keybindings: true,
  topicHistory: true,
  chatStartHistory: true,
} satisfies Record<keyof Settings, true>;

export const SETTINGS_FIELD_NAMES = Object.keys(SETTINGS_FIELDS) as Array<keyof Settings>;

/** Copy only persisted data from either Settings or the richer Zustand state. */
export function settingsSnapshot(source: Settings): Settings {
  return Object.fromEntries(
    SETTINGS_FIELD_NAMES.map((field) => [field, source[field]]),
  ) as unknown as Settings;
}
