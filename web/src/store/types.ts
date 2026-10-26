import { CURRENT_ADVANCED_DEFAULTS, type AdvancedDefaults } from '@/lib/advancedSettingsDefaults';
import { DEFAULT_CAMERA_AUTO_PAN, type CameraAutoPan } from '@/lib/cameraPreferences';
import type { CustomNodeFont } from '@/lib/customNodeFonts';

export type CatppuccinAccent =
  | 'rosewater' | 'flamingo' | 'pink' | 'mauve' | 'red' | 'maroon'
  | 'peach' | 'yellow' | 'green' | 'teal' | 'sky' | 'sapphire'
  | 'blue' | 'lavender';

export type NodeKind = 'root' | 'term-click' | 'follow-up' | 'modify' | 'manual' | 'explain' | 'interactive' | 'media' | 'chat';

/** A web-search source shown in the node's citations panel, numbered to match
 *  the inline ⟦n⟧ markers in the body. */
export interface NodeSource {
  n: number;
  url: string;
  title?: string;
  domain?: string;
}

/** Project-owned evidence is deliberately separate from web-search sources.
 * Internal markers use `(n)` while web markers retain `⟦n⟧`. */
export interface InternalNodeSource {
  n: number;
  sourceId: string;
  revisionId: string;
  passageId: string;
  sourceTitle: string;
  excerpt: string;
  page?: number;
  section?: string;
  originalUrl?: string;
  captureDate?: number;
}

export type ProjectSourceMode = 'ignore' | 'use' | 'only';
export type ProjectSourceKind = 'pdf' | 'docx' | 'text' | 'markdown' | 'image' | 'webpage';

export interface ProjectSourceIndexMeta {
  formatVersion: number;
  embeddingModel: string;
  embeddingRevision: string;
  dimensions: number;
}

/** A source revision becomes visible only after all referenced assets were
 * written and verified. Processing/failed rows live in a local staging journal
 * and never enter Project or sync. */
export interface ProjectSourceRevision {
  id: string;
  createdAt: number;
  status: 'ready';
  captureDate?: number;
  mimeType?: string;
  pageCount?: number;
  contentAssetId: string;
  keywordIndexAssetId: string;
  embeddingIndexAssetId?: string;
  /** Native PDF/DOCX bytes. Downloaded lazily on synced devices. OCR inputs
   * are never retained here. */
  originalAssetId?: string;
  index: ProjectSourceIndexMeta;
}

export interface ProjectSource {
  id: string;
  title: string;
  kind: ProjectSourceKind;
  checked: boolean;
  createdAt: number;
  contentHash: string;
  activeRevisionId: string;
  revisions: Record<string, ProjectSourceRevision>;
  originalUrl?: string;
}

export interface ProjectSourceLibrary {
  mode: ProjectSourceMode;
  /** The user's last Use/Only choice survives a temporary effective Ignore
   * state when every source is unchecked. */
  rememberedNonIgnoreMode?: 'use' | 'only';
  order: string[];
  sources: Record<string, ProjectSource>;
  /** Permanent deletion markers stop an older sync snapshot from reviving a
   * deleted source. They are compacted only after recovery history ages out. */
  tombstones?: Record<string, { deletedAt: number }>;
}

export interface SourceBlock {
  id: string;
  text: string;
  page?: number;
  section?: string;
  aiTranscription?: boolean;
}

export interface SourceChunk {
  id: string;
  blockId: string;
  text: string;
  page?: number;
  section?: string;
  start: number;
  end: number;
}

export interface NormalizedSourceDocument {
  schemaVersion: 1;
  revisionId: string;
  title: string;
  blocks: SourceBlock[];
  chunks: SourceChunk[];
}

export type SourceLimitationKind = 'not-enough-information' | 'limited-search';
export interface SourceLimitation {
  kind: SourceLimitationKind;
  message: string;
  action?: 'whole' | 'expand' | 'modify';
  reason?: string;
}

export type FactCheckVerdict =
  | 'supported'
  | 'mixed'
  | 'contradicted'
  | 'unverified';

export type FactCheckEvidenceStance = 'supports' | 'contradicts' | 'context';

export interface FactCheckEvidence {
  url: string;
  title?: string;
  domain?: string;
  stance: FactCheckEvidenceStance;
  excerpt?: string;
  /** Provider excerpts are exact; AI excerpts are short leads that must be
   * checked against the linked source. */
  excerptOrigin?: 'source' | 'ai';
}

export interface FactCheckFinding {
  googleSearchSuggestions?: string[];
  verdict: FactCheckVerdict;
  explanation: string;
  unverifiedReason?: 'not_factual' | 'insufficient_evidence';
  evidence: FactCheckEvidence[];
}

export interface FactCheckUnit {
  id: string;
  order: number;
  stage: 'opening' | 'bullets' | 'prose';
  kind: 'sentence' | 'sub-bullet';
  text: string;
  sectionTitle?: string;
  sentenceIndex?: number;
  bulletIndex?: number;
  childIndex?: number;
  state: 'pending' | 'complete' | 'failed';
  finding?: FactCheckFinding;
  error?: string;
}

export interface FactCheckReport {
  schemaVersion: 1;
  bodyFingerprint: string;
  versionCreatedAt: number;
  providerId: string;
  model: string;
  startedAt: number;
  completedAt?: number;
  stoppedAt?: number;
  complete: boolean;
  units: FactCheckUnit[];
  failedUnitIds: string[];
}

/** The last successful report remains available while a replacement streams. */
export interface FactCheckState {
  complete?: FactCheckReport;
  pending?: FactCheckReport;
}

export type FreeImageSource = 'wikimedia' | 'openverse';

export type FreeImageCatalogStatus = 'success' | 'rate-limited' | 'unavailable';

/** Outcome of one external catalog during a recommendation run. */
export interface FreeImageSourceOutcome {
  source: FreeImageSource;
  status: FreeImageCatalogStatus;
  /** Included when the service supplies Retry-After or a reset timestamp. */
  retryAt?: number;
  message?: string;
}

/** Normalized metadata for one freely reusable image. The optional Commons
 * fields keep Wikimedia-only projects from older Scatter builds readable. */
export interface FreeImageRecommendation {
  /** Missing on legacy records means Wikimedia. */
  source?: FreeImageSource;
  sourceId?: string;
  landingPageUrl?: string;
  pageId?: number;
  fileTitle?: string;
  filePageUrl?: string;
  thumbnailUrl: string;
  originalUrl: string;
  caption: string;
  /** One concise model-written sentence explaining why this visual helps
   * with the exact node that requested it. Optional for old saved projects. */
  relevance?: string;
  description?: string;
  creator?: string;
  creatorUrl?: string;
  license: string;
  licenseUrl?: string;
  creditLine: string;
  mime?: string;
  width?: number;
  height?: number;
  provider?: string;
  tags?: string[];
  fieldsMatched?: string[];
  /** Article association supplies identity evidence, not permission to reuse. */
  articleTitle?: string;
  articleUrl?: string;
}

/** Persisted provider-neutral result set. Active requests remain runtime-only. */
export interface FreeImageRecommendationSet {
  schemaVersion: 2;
  bodyFingerprint: string;
  providerId?: string;
  model?: string;
  /** Missing on legacy sets means AI-assisted discovery. */
  mode?: 'automatic' | 'manual';
  searchedAt: number;
  /** Review limit, or the number of direct catalog results requested per page. */
  resultLimit: number;
  manualQuery?: string;
  /** Opaque continuation positions supplied by each catalog. */
  next?: { wikimedia?: number; openverse?: number };
  sourceOutcomes: FreeImageSourceOutcome[];
  results: FreeImageRecommendation[];
}

/** Legacy names remain exported for source compatibility with old tests and
 * saved-project helpers. */
export type WikimediaImageRecommendation = FreeImageRecommendation;
export interface WikimediaRecommendationSet {
  schemaVersion: 1;
  bodyFingerprint: string;
  providerId: string;
  model: string;
  searchedAt: number;
  resultLimit: number;
  manualQuery?: string;
  results: WikimediaImageRecommendation[];
}

/** License/provenance that follows a spawned or edited local media asset. */
export interface WikimediaAttribution {
  pageId: number;
  fileTitle: string;
  filePageUrl: string;
  originalUrl: string;
  creator?: string;
  creatorUrl?: string;
  license: string;
  licenseUrl?: string;
  creditLine: string;
  modified?: boolean;
}

/** License/provenance for any freely licensed image catalog. */
export interface FreeImageAttribution {
  source: FreeImageSource;
  sourceId: string;
  landingPageUrl: string;
  originalUrl: string;
  creator?: string;
  creatorUrl?: string;
  license: string;
  licenseUrl?: string;
  creditLine: string;
  modified?: boolean;
}

/** A node title split into semantic user text and optional visual adornments.
 * The split lets card headers shorten only the meaningful text while keeping
 * labels such as “Image” and “explained” intact. */
export interface HeaderParts {
  /** Visual label rendered before the subject, without its trailing colon. */
  prefix?: string;
  /** Main topic, selected passage, or image description. */
  subject: string;
  /** Optional follow-up question, without its leading colon. */
  question?: string;
  /** Visual label rendered after the subject/question, without its dash. */
  suffix?: string;
}

/** A self-contained program owned by a dedicated interactive node. Its HTML
 * runs only in Scatter's restricted iframe, never in the app's own document. */
export interface InteractiveExplanation {
  html: string;
  /** Complete semantic request used to build and later repair the program. */
  request: string;
  providerId: string;
  model: string;
  /** Legacy square viewport retained for existing saved projects. New
   * interactive documents store explicit landscape dimensions below. */
  viewportSize?: 580;
  viewportWidth?: number;
  viewportHeight?: number;
  /** Version-owned generation/validation failure. Runtime interaction errors
   * stay transient until the user requests a repair. */
  error?: string;
}

/** Compact, persisted build transcript. Never contains private model reasoning. */
export interface InteractiveBuild {
  request: string;
  state: 'building' | 'complete' | 'failed' | 'stopped';
  steps: { id: number; label: string; state: 'running' | 'complete' | 'failed'; detail?: string; kind?: 'info' | 'paused' }[];
  draftHtml?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  error?: string;
  /** Last confirmed program defects survive a later capture/reviewer failure. */
  pendingIssues?: string[];
  warnings?: string[];
  /** Resume verification before spending a coding repair on infrastructure. */
  verificationPending?: boolean;
  /** Explicit human approval, distinct from passing automated review. */
  acceptedByUser?: boolean;
  /** Persist accepted tests and progress so an explicit extra pass resumes them. */
  plan?: import('@/lib/interactiveWorkflow').InteractivePlan;
  repairPasses?: number;
  limitReached?: boolean;
  providerId?: string;
  model?: string;
}

export interface NodeVersion {
  /** Captured per version/answer. Legacy versions are English. */
  language?: import('@/lib/languages').GenerationLanguage;
  /** The free-writing variant uses the Answer renderer and editing model. */
  markdownNote?: boolean;
  /** Identical answer copies share automatic term marking and preview work.
   * Manual edits/regeneration detach by omitting this derived identity. */
  answerEnrichmentId?: string;
  /** Durable, exact-text progress; interrupted answer copies can resume marking. */
  answerTermMarking?: { fingerprint: string; state: 'pending' | 'complete' | 'failed'; error?: string };
  /** Dedicated interactive card; absent on older prose + program explanations. */
  interactiveStandalone?: boolean;
  interactiveBuild?: InteractiveBuild;
  /** Explicit blank text card waiting for its first generation prompt. */
  emptyText?: boolean;
  /** Preserve the initial 4:5 frame while its first answer streams. */
  initialTextFrame?: boolean;
  /** Derived term explanations for this exact text; persisted, not a new edit. */
  termPreviews?: { fingerprint: string; entries: Record<string, string>; exhaustedTerms?: string[]; error?: string };
  /** Rich answer metadata, owned by a chat turn or a detached Answer snapshot. */
  chat?: import('./chatTypes').ChatAnswerMetadata;
  header: string;
  /** Complete structured title. `header` remains the flattened compatibility
   * string used by exports, search, and older saved projects. */
  headerParts?: HeaderParts;
  body: string;
  createdAt: number;
  generatedBy: NodeKind;
  /** Complete question for a child spawned by asking about selected text.
   *  Its display header may shorten the passage, so regeneration combines
   *  this with the incoming arrow's full `sourceSelection.text`. */
  selectedTextQuestion?: string;
  modelUsed?: string;
  /** Web-search sources cited in this version's body (when web search was on).
   *  The body carries ⟦n⟧ markers pointing at these by `n`. */
  sources?: NodeSource[];
  /** Required Google Search attribution UI, separate from editable answer text. */
  googleSearchSuggestions?: string[];
  /** Project-owned evidence cited with `(n)` markers. The compact excerpt is
   * retained with the version even if the full source is later deleted. */
  internalSources?: InternalNodeSource[];
  /** Presentation-only strict/fallback notice; excluded from article text,
   * search, export, term marking, and future model context. */
  sourceLimitation?: SourceLimitation;
  /** True only when the provider confirmed actual hosted-search activity. */
  webSearched?: boolean;
  /** Search was requested and usable text arrived, but the provider did not
   * confirm a successful search. Retained as provenance metadata; Scatter no
   * longer renders search-status labels in the node footer. */
  webSearchFailed?: boolean;
  /** Per-version evidence review. Findings are persisted without creating
   * undo entries; active network controllers remain runtime-only. */
  factCheck?: FactCheckState;
  /** Provider-neutral image recommendations for this exact version. */
  imageRecommendations?: FreeImageRecommendationSet;
  /** Legacy Wikimedia-only recommendations for projects saved before the
   * Openverse integration. */
  wikimediaImages?: WikimediaRecommendationSet;
  // ── Per-version sizing ──────────────────────────────────────────────
  // Each version's content wraps differently, so the computed sizes live
  // on the version (not the node) — switching versions restores that
  // version's own dimensions. Computed by AdaptiveBullets on any text
  // change; the user's manual resize writes width / bodyMaxHeight here too.
  /** Total card width (canvas px). Falls back to DEFAULT_NODE_W. */
  width?: number;
  /** Manual interactive canvas size. Separate from legacy text width; the
   * program's intrinsic viewport and enlarged viewer never change on resize. */
  interactiveCanvasWidth?: number;
  /** Per-version MINIMUM card width — raised by the 3:2 aspect cap (see
   *  the node-level docs that previously lived here). The floor labs
   *  measure at this width and resize can't go narrower. */
  minWidth?: number;
  /** Body max-height (canvas px) — controls the scroll threshold / current
   *  body height. Falls back to DEFAULT_BODY_MAX_H. */
  bodyMaxHeight?: number;
  /** Minimum body height the resize handle may shrink to (computed). */
  minBodyHeight?: number;
  /** Body height at which every L1 bullet fits at its maxMode. */
  fullBodyHeight?: number;
  /** Cached measured height (CSS px) of the opening freetext paragraph. */
  freeTextHeight?: number;
  /** Node width at which expanded bullet/body measurements were last refreshed. */
  expandedMeasureWidth?: number;
  /** Present on a `type:'media'` node's version once a photo/video is attached
   *  (undefined while it's still an empty chooser). Per-version so "Replace
   *  media" can keep the previous media as an earlier, switchable version. */
  media?: MediaRef;
  /** Reproducibility record for an AI-generated media version. Optional so all
   * existing projects and manually attached media remain unchanged. */
  imageGeneration?: ImageGenerationProvenance;
  /** Immutable visual context for an image follow-up, including retry/export. */
  imageContext?: ImageQuestionContext;
  /** Original region question, retained after its vague prompt becomes a title. */
  imageQuestion?: string;
  imageTitleState?: 'pending' | 'complete' | 'failed';
  /** Completed program, separate from its searchable request/summary in body. */
  interactive?: InteractiveExplanation;
  // ── Per-version type + bullet cap ────────────────────────────────────
  /** Encyclopedic level-1 bullet cap used when THIS version was generated.
   *  Undefined = the default (DEFAULT_MAX_L1_BULLETS = 10). Only "Expand
   *  whole" raises it (+1); Regenerate resets it; Modify / Edit-text carry it
   *  forward. Tracked per version so a node can hold differently-capped
   *  versions side by side in the switcher. See lib/nodeContentType.ts. */
  maxL1Bullets?: number;
  /** This version's content FORMAT — drives the bottom-margin type tag AND the
   *  render/behaviour decisions (so switching to an older, differently-typed
   *  version renders correctly). Undefined on legacy versions → derived from
   *  the node's `type` by `currentContentType()`. */
  contentType?: 'encyclopedic' | 'explain' | 'interactive' | 'media' | 'chat' | 'answer';
}

export type NodeType = 'root' | 'term-click' | 'follow-up' | 'manual-empty' | 'explain' | 'interactive' | 'media' | 'chat';

/** Photo/video provider for embed media. */
export type MediaProvider = 'youtube' | 'vimeo';
export type MediaKind = 'image' | 'video' | 'embed';

/**
 * Small descriptor of the media attached to a `type:'media'` node. Lives on the
 * NODE (not a version) — media is node-scoped and there's only ever one version.
 *
 * CRITICAL: this holds only an `assetId` + metadata, never bytes. The whole
 * `project` is the undo target (zundo, limit 100) and is serialized to OPFS on
 * every change, so binary data must stay in a separate OPFS asset file and its
 * object URL in the runtime `useMediaUrlStore`.
 */
export interface MediaRef {
  /** 'asset' = copied into OPFS (uploads/pastes); 'link' = live remote URL (no
   *  bytes stored); 'embed' = YouTube/Vimeo. */
  source: 'asset' | 'link' | 'embed';
  kind: MediaKind;
  /** OPFS asset id when source==='asset'. Bytes at projects/<pid>/assets/<id>. */
  assetId?: string;
  /** Live remote URL when source==='link'. */
  url?: string;
  mime?: string;
  /** Intrinsic pixel dimensions — drive aspect-locked sizing. */
  naturalWidth?: number;
  naturalHeight?: number;
  /** Embed-only. */
  provider?: MediaProvider;
  embedId?: string;
  thumbnailUrl?: string;
  /** Original filename (uploads) — seeds the auto-title. */
  fileName?: string;
  /** Byte size of a stored asset — used for the large-video heads-up. */
  byteSize?: number;
  /** When set, the node shows a calm "unsupported format" card instead of media. */
  unsupportedReason?: string;
  /** Provenance and license information for a Commons-derived local asset. */
  wikimedia?: WikimediaAttribution;
  /** Provider-neutral provenance for newly spawned freely licensed images. */
  freeImage?: FreeImageAttribution;
}

export interface ScatterNode {
  /** Migration identity used to deduplicate extracted legacy programs on sync. */
  legacyInteractiveSourceId?: string;
  chat?: import('./chatTypes').ChatConversation;
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  frozen: boolean;
  groupId?: string;             // unused in Plan 1
  versions: NodeVersion[];
  currentVersionIndex: number;
  // NOTE: card-size fields (width, minWidth, bodyMaxHeight, minBodyHeight,
  // fullBodyHeight, freeTextHeight, expandedMeasureWidth) now live PER-VERSION on NodeVersion —
  // each version's content wraps differently, so switching versions restores
  // that version's own dimensions. Read them via the nodeWidth() /
  // nodeBodyMaxH() / nodeMinWidth() helpers (which resolve the current
  // version), and write them via the store's setVersionSize action.
  // Transient generation state:
  generating?: boolean;
  /** Version currently owned by the generation session. Runtime-only. */
  generatingVersionIndex?: number;
  /** True only while pass-1 TEXT is streaming into this node (spawn,
   *  restructure, whole rewrite) — false during the chip-marking pass even
   *  though `generating` stays true. Drives the tail skeleton (the ghost
   *  bullet that signals more bullets are coming) and its sizing reserve.
   *  Transient like `generating`: stripped before save (projectIO). */
  streamingText?: boolean;
  generationError?: string;
  renderedHeight?: number;  // measured by NodeView via ResizeObserver, used by ArrowLayer + rectCollide
  /** User has clicked the chevron toggle in node-footer to hide the
   *  bullets section, leaving only the opening paragraph. Persisted
   *  so the choice survives reloads. Defaults to `false`/undefined
   *  (expanded). */
  bulletsCollapsed?: boolean;
  /** Per-node override of the global "information chunking" setting
   *  (Settings.sentencePerLine) for THIS node's introduction. When set,
   *  it decides whether the opening paragraph is broken into one line per
   *  sentence (on canvas and in the editor). `undefined` = inherit the
   *  global default. Persisted; lossless (purely presentational). */
  chunkIntro?: boolean;
  /** Reading position: index of the L1 bullet forced active (expanded),
   *  absent when none. Written ONLY at save time by foldRuntime from the
   *  transient useActiveIdxStore (wheel ticks stay out of live edits and
   *  undo history) and seeded back into that store on project load. */
  activeBulletIdx?: number;
}

export interface ArrowSourceSelectionPart {
  sourceField: string;
  start: number;
  end: number;
  text: string;
}

/**
 * A semantic source anchor for a child created from selected text. Optional on
 * arrows so existing projects remain compatible without migration.
 */
export interface ArrowSourceSelection {
  sourceVersionCreatedAt: number;
  /** Stable tie-breaker when selected-text relations overlap. */
  createdAt: number;
  text: string;
  parts: ArrowSourceSelectionPart[];
}

export interface Arrow {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: 'auto' | 'dotted';      // structural parent or visual-only shared reference
  label?: string;
  sourceSelection?: ArrowSourceSelection;
  /** Atlas exception: this relation starts at selected pixels in its source image. */
  sourceImage?: ImageQuestionContext;
  /** Exact origin inside a chat; absence retains ordinary node semantics. */
  sourceAnswer?: import('./chatTypes').ChatAnswerRef;
  /** Stable ordering for promotion of a surviving shared-child reference. */
  createdAt?: number;
  /** Legacy field kept for file compatibility; only kind:'auto' attracts nodes. */
  gravitates?: boolean;
  /**
   * Persisted Verlet-rope anchor positions so the rope resumes its settled
   * shape on reload. Snapshotted by the autosave layer from the runtime
   * `useArrowAnchorsStore`. Optional — if absent or shorter than 2, the
   * worker seeds a fresh straight-line chain between the rect borders.
   */
  anchors?: { x: number; y: number }[];
}

/** A group's color: a named Catppuccin accent OR a user-defined `#rrggbb` hex.
 *  The `(string & {})` keeps accent-name autocomplete while allowing any hex. */
export type GroupColor = CatppuccinAccent | (string & {});

/** Automatic palette strategy used when Scatter creates a group color. */
export type GroupColorAssignment =
  | 'opposites'
  | 'golden-angle'
  | 'hierarchy-aware';

export interface Group {
  id: string;
  name: string;
  color: GroupColor;
  gravitate: boolean;
  /** The group exists immediately; only its automatic title is pending.
   * Kept with the group so selection changes do not own/cancel the request. */
  titleGeneration?: { id: string; headers: string[]; error?: string };
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  rootNodeId: string;
  nodes: Record<string, ScatterNode>;
  arrows: Record<string, Arrow>;
  groups: Record<string, Group>;        // empty in Plan 1
  /** Optional for backward compatibility. Source-free projects pay no storage
   * or initialization cost until this field is first created. */
  sourceLibrary?: ProjectSourceLibrary;
  viewport: { x: number; y: number; zoom: number };
  /** Camera navigation is synchronized independently from content edits. */
  viewportUpdatedAt?: number;
  selection: string[];
  /**
   * The project's base color — what ungrouped nodes and the root node wear
   * instead of grey. Seeded randomly at creation, lazily assigned on load for
   * older projects (ensureProjectColor), and BLOCKED from group
   * auto-assignment. Absent only on legacy data mid-load; consumers fall back
   * to the old neutral greys then.
   */
  color?: GroupColor;
  /**
   * Last hue emitted by the golden-angle allocator. Kept independently from
   * the visible colors so manual recoloring and deletion do not rewind the
   * sequence. Older projects derive their first cursor from `color`.
   */
  goldenColorCursorHue?: number;
  /** Original project hue and last emitted step for the binary "pie slicing"
   * opposites sequence. Kept apart from visible colors for the same reason as
   * the golden cursor: recoloring and deletion must not rewind it. */
  oppositesColorBaseHue?: number;
  oppositesColorCursorIndex?: number;
}

/** Lightweight per-scatter metadata held in the sidebar registry. Just enough
 *  to render the Scatters list + sort by recency — the full {@link Project}
 *  lives in its own OPFS file (`projects/<id>.json`) and is only loaded for the
 *  active scatter. */
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Mirror of {@link Project.color} so sidebar rows can tint + open the
   *  color picker without loading the full project file. Kept in sync by
   *  metaOf (create/flush/open) and recolorScatter; absent on registry rows
   *  written before this field existed (self-heals when the scatter is
   *  opened or its color edited). */
  color?: GroupColor;
}

/** The multi-scatter registry, persisted to `projects/index.json`. `activeId`
 *  is the scatter currently loaded into `useGraphStore.project`. */
export interface ProjectsIndex {
  activeId: string | null;
  items: ProjectMeta[];
}

export type ProviderPreset =
  | 'gemini'
  | 'openai' | 'anthropic' | 'openrouter'
  | 'ollama' | 'lm-studio' | 'custom';

/** How hard the generation model should "think" before answering. 'off'
 *  disables reasoning where the provider supports disabling it; low/medium/high
 *  request that effort. Only honored by reasoning-capable models (a no-op
 *  elsewhere). Applied to the MAIN node generation; the chip pass stays 'low'. */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** How OpenRouter chooses among ordinary provider endpoints for the same
 * model. `fast-start` minimizes time to first text; `lowest-cost` explicitly
 * orders providers by price. Non-OpenRouter providers ignore this setting. */
export type OpenRouterRoutingPreference = 'fast-start' | 'lowest-cost';

/** Legacy single-provider config. Kept only so the settings migration can
 *  read pre-multi-provider saves; the live app uses {@link ProviderAccount}. */
export interface ProviderConfig {
  preset: ProviderPreset;
  apiKey: string;
  baseUrl?: string;        // override; only required for 'custom' preset
  selectedModel: string;
  webSearch: boolean;
}

/** One configured AI provider. The user can connect several (e.g. OpenAI +
 *  OpenRouter) and expose a chosen subset of each provider's models to the
 *  model switcher via {@link ProviderAccount.enabledModels}. */
/** Search is executed by the user's model server, not by an app backend.
 * Only explicitly selected search servers/tools are enabled for a request. */
export type ServerSearch =
  | { kind: 'lmstudio-mcp'; server: string; tools: string[] }
  | { kind: 'responses-mcp'; url: string; tools: string[] }
  | { kind: 'localai'; servers: string[] };

export interface ProviderAccount {
  id: string;              // stable id, survives reorders/edits
  preset: ProviderPreset;
  name?: string;           // optional label for local/custom connections
  apiKey: string;
  baseUrl?: string;        // override; required for 'custom'
  /** Optional browser-accessible SearXNG base URL for local/custom models. */
  webSearchEndpoint?: string;
  serverSearch?: ServerSearch;
  enabledModels: string[]; // models the user surfaced into the switcher
}

/** Which (provider, model) pair is currently active for generation. */
export interface ActiveModelRef {
  providerId: string;
  model: string;
}

/** Provider-defined image quality token, such as high, standard, or hd. */
export type ImageQuality = string;

export interface ImageGenerationSettings {
  quality: ImageQuality;
  /** `custom` uses customWidth/customHeight; `auto` delegates to the model. */
  size: string;
  /** For models that expose both shape controls and exact sizes, opt into the
   * exact-size override instead of sending conflicting request fields. */
  useExactSize: boolean;
  customWidth: number;
  customHeight: number;
  resolution: string;
  aspectRatio: string;
  outputFormat: string;
  background: string;
  outputCompression: number;
  /** null delegates randomness to the provider. */
  seed: number | null;
  moderation: string;
  inputFidelity: string;
}

export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageQuestionContext {
  sourceMedia: MediaRef;
  /** Optional for image questions saved before atlas origins were introduced. */
  sourceVersionCreatedAt?: number;
  /** Union of rectangles in normalized (0..1) source-image coordinates. */
  regions: ImageRegion[];
}

export interface ImageGenerationProvenance {
  /** The exact effective prompt sent to the image provider. */
  prompt: string;
  promptSource: 'selected-text' | 'media-prompt' | 'image-edit';
  providerId: string;
  model: string;
  quality?: ImageQuality;
  size?: string;
  resolution?: string;
  aspectRatio?: string;
  outputFormat?: string;
  background?: string;
  outputCompression?: number;
  seed?: number;
  moderation?: string;
  inputFidelity?: string;
  /** Stable input for regenerating an AI edit as a variation of the same source. */
  sourceMedia?: MediaRef;
  /** Empty/absent means whole image; overlaps form one union used to guide
   * the model, not to cut and paste its output into the original. */
  selectedRegions?: ImageRegion[];
  /** Original request, kept separately so edited templates can still adapt
   * their mask/close-up guides to a provider's supported image count. */
  editInstruction?: string;
}

/** A single keyboard binding for a rebindable app action. `meta` is the
 *  cross-platform modifier (Ctrl on Windows/Linux, ⌘ on macOS); `key` is the
 *  lowercased KeyboardEvent.key (e.g. 'k', 'z', 'f'). */
export interface KeyBinding {
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type ModelRole = 'main' | 'secondary' | 'interactive' | 'image';
export type ModelRecommendations = Record<ModelRole, {
  autoUpdate: boolean;
  /** The managed slot, not necessarily the currently active main model. */
  ref?: ActiveModelRef;
  version?: string;
}>;

export interface Settings {
  generationLanguage?: import('@/lib/languages').GenerationLanguage;
  modelRecommendations?: ModelRecommendations;
  /** Explicit per-role opt-out from metadata-based selection checks. Does not
   * invent capabilities or relax checks on automatic model updates. */
  modelCompatibilityOverrides?: Partial<Record<ModelRole, boolean>>;
  providers: ProviderAccount[];
  activeModelRef: ActiveModelRef | null;
  /** User-defined order shared by the main-model library and keyboard switcher. */
  mainModelOrder?: ActiveModelRef[];
  /** Optional dedicated model shared by inexpensive secondary work: follow-up
   * routing, term marking and previews, and free-image discovery. */
  secondaryModelRef?: ActiveModelRef;
  /** Use the active generation model for every secondary task (default true). */
  secondaryUseSameModel: boolean;
  /** Optional explicit model for interactive-program generation. Undefined
   * means "use the active main text model". */
  interactiveModelRef?: ActiveModelRef;
  /** Independent of the main model's canvas control. */
  interactiveReasoningEffort: ReasoningEffort;
  /** Dedicated model for image generation and the image editor's future AI
   * modification flow. `undefined` means an older/new setup has not chosen
   * yet (the picker may apply its GPT default); `null` is the user's explicit
   * “None” choice and must never be auto-replaced. */
  imageModelRef?: ActiveModelRef | null;
  imageGenerationSettings: ImageGenerationSettings;
  /** Global, per-generation web-search toggle (replaces the old per-provider
   *  flag). Read at request time; only takes effect when the active model can
   *  actually search (see registry.modelSupportsWebSearch). Enabled by default. */
  webSearch: boolean;
  /** Generate hover explanations in the background. Linked-node previews remain available. */
  autoTermPreviews: boolean;
  /** Discover free images in the background; manual searches remain available. */
  autoFreeImages: boolean;
  /** Explicit cloud opt-in; sync-service passwords and OAuth tokens remain local. */
  syncApiKeys: boolean;
  /** Automatic movement only. Explicit navigation and fit controls remain available. */
  cameraAutoPan: CameraAutoPan;
  /** Initial formatting mode for new chats; existing conversations keep their choice. */
  defaultChatInformationChunking: boolean;
  /** Selection-toolbar searches open a browser tab; unrelated to AI search. */
  selectionWebSearch: import('@/lib/selectionWebSearch').SelectionWebSearchSettings;
  /** Provider routing for OpenRouter text requests. Missing legacy values
   * deliberately migrate to fast-start so existing users receive the improved
   * responsiveness as soon as this app version loads. */
  openRouterRouting: OpenRouterRoutingPreference;
  /** Render each sentence of a node's opening paragraph on its own line
   *  (readability via information chunking). Default true; turn off to show the
   *  paragraph as a single justified block (the previous style). Pure
   *  render-level preference — does not affect generation. */
  sentencePerLine: boolean;
  /** Typeface for node titles and readable node content only; app controls
   * keep Atkinson. A render-level preference, not project data. */
  nodeFontId: string;
  /** Embedded files travel with settings exports and cloud preferences. */
  customNodeFonts: CustomNodeFont[];
  /** Chat instructions apply to new/regenerated answers in both chunking modes.
   * Keep the stored key for compatibility with existing exports and sync. */
  normalChatInstructions?: string;
  /** Justify the node's opening paragraph (vs. left-align). Default false
   *  (left). Independent of `sentencePerLine`. Pure render-level preference. */
  justifyParagraph: boolean;
  /** In a node's follow-up box, plain Enter sends the follow-up (default true).
   *  When false, plain Enter inserts a newline and Ctrl/⌘+Enter sends.
   *  Shift+Enter always inserts a newline. Pure input-behaviour preference. */
  followUpEnterSends: boolean;
  /** Automatic group-color strategy. Missing legacy values migrate to the
   * hierarchy-aware default without recoloring existing projects. */
  groupColorAssignment: GroupColorAssignment;
  /** Degrees to rotate the hue of UI accents (arrow lines, resize handles) off a
   *  node's group color — signed; an analogous-color shift. Default 33. */
  accentHueShift: number;
  /** Saturation to remove from those accents, in absolute % points (0 = unchanged). */
  accentDesaturate: number;
  /** Lightness to remove from those accents, in absolute % points (0 = unchanged). */
  accentDarken: number;
  /** Preferred main-model effort; coerced to the model's supported levels. */
  reasoningEffort: ReasoningEffort;
  outputTokenCap: number;
  /** Per-step interactive limit; secondary tasks scale their existing budgets. */
  interactiveOutputTokenCap: number;
  secondaryOutputTokenCap: number;
  generationLimitsVersion?: 1;
  inputTokenCap: number;
  physicsConfig?: PhysicsConfig;
  bulletSizingConfig?: BulletSizingConfig;
  customPrompts?: Partial<CustomPrompts>;
  /** Defaults that advanced overrides were based on. No saved configurations
   * or history; mismatches reset on load, import and sync. */
  advancedDefaults?: AdvancedDefaults;
  /** User-added custom group colors (hex `#rrggbb`). The built-in accents are
   *  not stored here. Shared across all groups; deletable by the user. */
  customColors: string[];
  /** User overrides for rebindable keyboard shortcuts, keyed by action id
   *  (see lib/keymap.ts KEY_ACTIONS). Each action may have up to 2 bindings
   *  (primary + alternative). Action ids absent here use their defaults. */
  keybindings?: Record<string, KeyBinding[]>;
  /** Recently-explored topic queries the user typed/picked in the topic
   *  picker. Most-recent-first, deduped, capped. Purely a convenience history —
   *  independent of projects; removing an entry never touches any project. */
  topicHistory?: string[];
  /** First prompts used to start chat projects; separate from topic history. */
  chatStartHistory?: string[];
}

/** Tuning knobs for AdaptiveBullets's body-sizing algorithm. The cascade
 *  + measure-correct logic uses these to decide how much "headroom" to
 *  reserve above the strict A/B floor and how aggressively to demote /
 *  promote bullets when the visible content overflows or underflows the
 *  computed body. See the long comment in AdaptiveBullets.tsx for what
 *  each knob does. */
export interface BulletSizingConfig {
  /** Fraction of (raw fit = max(A,B) + freetext + overhead) added to
   *  minBodyHeight as safety. 0.40 = body is 40 % bigger than strict
   *  math says — generous headroom for measurement gaps. */
  safetyFraction: number;
  /** Absolute minimum safety in px. Used when safetyFraction × raw is
   *  smaller (so short nodes still get a reasonable buffer). */
  safetyMinPx: number;
  /** Cascade lets sum-of-items exceed avail by up to this many px
   *  before triggering a demote. Smaller = tighter fit but risks
   *  oscillation. */
  overflowTolerance: number;
  /** Cascade lets sum-of-items fall below avail by up to this many px
   *  before triggering a promote. */
  underflowTolerance: number;
  /** Cap on demote/promote iterations per inputKey change. Prevents
   *  infinite loops if cascade can't converge. */
  maxAdjustmentIter: number;
}

export interface PhysicsConfig {
  linkedRepelStrength: number;
  unlinkedRepelStrength: number;
  /** Linear falloff zone (px) for pairwise repulsion. Force is zero at this distance and full at zero. */
  repelRange: number;
  linkDistance: number;
  linkStrength: number;
  collidePadding: number;
  arrowAvoidPadding: number;
  /** Target spacing (px) between adjacent rope anchors when sampling along
   *  the routed polyline. Smaller = denser sampling = smoother bezier. */
  ropeMaxSegmentLength: number;
  /** Hard cap on anchors per rope. */
  ropeMaxAnchorCount: number;
  /** Cubic-bezier control point distance as fraction of shorter adjacent segment. 0 = polyline, 0.25 = natural smooth, 0.4+ = puffy. */
  ropeSmoothing: number;
  /** Inflation (px) applied to every obstacle when building the visibility graph. The visual clearance between rope and node bodies. */
  ropeMargin: number;
  /** Push between rope anchors of DIFFERENT arrows. 0..1, fraction of (range - dist) closed per pass. */
  arrowRepelStrength: number;
  /** Distance at which arrow-arrow repel falls off to zero. */
  arrowRepelRange: number;
  /** 0 = ropes route around currently-dragged nodes (default). 1 = ropes
   *  ignore dragged nodes and pass through their position. (Boolean used
   *  as 0/1 so it fits the slider grid in dev settings.) */
  ropeExemptDraggedNodes: number;
  velocityDecay: number;
  alphaDecay: number;
}

/** The catalog is the single source of truth for editable prompt fields. */
export type CustomPrompts = Record<import('@/lib/promptCatalog').PromptKey, string>;

export const DEFAULT_TEXT_PROVIDER: ProviderConfig = {
  preset: 'openai',
  apiKey: '',
  selectedModel: '',
  webSearch: false,
};

export const DEFAULT_SETTINGS: Settings = {
  modelCompatibilityOverrides: {},
  modelRecommendations: {
    main: { autoUpdate: true }, secondary: { autoUpdate: true },
    interactive: { autoUpdate: true }, image: { autoUpdate: true },
  },
  mainModelOrder: undefined,
  providers: [],
  activeModelRef: null,
  secondaryUseSameModel: false,
  interactiveReasoningEffort: 'high',
  imageGenerationSettings: {
    quality: 'high',
    size: '1536x1024',
    useExactSize: false,
    customWidth: 1536,
    customHeight: 1024,
    resolution: '2K',
    aspectRatio: '3:2',
    outputFormat: 'png',
    background: 'auto',
    outputCompression: 90,
    seed: null,
    moderation: 'auto',
    inputFidelity: 'high',
  },
  webSearch: true,
  selectionWebSearch: { engineId: 'google', customEngines: [] },
  autoTermPreviews: true,
  autoFreeImages: false,
  syncApiKeys: false,
  cameraAutoPan: { ...DEFAULT_CAMERA_AUTO_PAN },
  defaultChatInformationChunking: true,
  openRouterRouting: 'fast-start',
  // Default look = one sentence per line (with the tree connector), justified.
  // Users can switch to a single block and/or left-align from Settings → Canvas.
  sentencePerLine: true,
  nodeFontId: 'app',
  generationLanguage: 'en',
  customNodeFonts: [],
  normalChatInstructions: '',
  justifyParagraph: true,
  followUpEnterSends: true,
  groupColorAssignment: 'hierarchy-aware',
  accentHueShift: 33,
  accentDesaturate: 0,
  accentDarken: 20,
  // Default 'low': today the main pass sends no effort, so reasoning models run
  // at their OWN default (often higher/costlier). 'low' is a deliberate, cheaper
  // baseline the user can raise. Reasoning is billed as output tokens.
  reasoningEffort: 'low',
  // Reasoning shares the output budget: a measured Gemini 3.8 Flash node used
  // 5,986 hidden reasoning tokens before its ~1,500-token visible answer.
  // Leave room for both, without asking the model to make its answer longer.
  outputTokenCap: 16_000,
  secondaryOutputTokenCap: 12_000,
  interactiveOutputTokenCap: 50_000,
  generationLimitsVersion: 1,
  advancedDefaults: CURRENT_ADVANCED_DEFAULTS,
  inputTokenCap: 3000,
  customColors: [],
};
