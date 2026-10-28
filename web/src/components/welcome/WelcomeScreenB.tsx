'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Download, X, ChevronLeft, ChevronRight, Sparkles, Maximize2, Settings } from 'lucide-react';
import { generateRoot, oneShotCompletion } from '@/lib/generate';
import { effectivePrompt, substitute } from '@/lib/promptDefaults';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { createScatter, deleteScatter, importScatterFromFile, switchScatter } from '@/store/projectActions';
import { ProjectImportError } from '@/lib/projectTransfer';
import { TOPIC_SUGGESTIONS, shuffle, intoRows } from '@/lib/topicSuggestions';
import { SidebarModelPicker } from '@/components/SidebarModelPicker';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';
import { SourceControls } from '@/components/sources/SourceControls';
import { SourceManager } from '@/components/sources/SourceManager';
import { colorToCss } from '@/lib/groupColor';
import { TopicInputWindow } from './TopicInputWindow';
import { ImageProjectInput } from './ImageProjectInput';
import { WelcomeTabShape } from './WelcomeTabShape';
import { startChatRoot, startImageRoot, type ProjectStartImage } from '@/lib/projectStart';
import { generationLanguagePrompt } from '@/lib/generationLanguage';
import { useDecorativeMotion } from '@/hooks/useDecorativeMotion';

type StartMode = 'topic' | 'chat' | 'image';
const START_MODES: StartMode[] = ['chat', 'topic', 'image'];

/** Recently-explored rows per page before the pager appears. */
const PAGE_SIZE = 8;
/** Per-row scroll RATE (seconds each pill spends crossing) + phase offsets. The
 *  animation duration is DERIVED from the row's item count (duration = count ×
 *  rate), so the drift speed stays CONSTANT no matter how many suggestions are in
 *  the wall — adding more pills never speeds it up. Different per-row rates make
 *  the three rows drift at their own leisurely pace; it doesn't pause on hover,
 *  so it must stay slow enough to read and click a passing pill. */
const ROW_SECS_PER_ITEM = [8, 10.5, 9];
const ROW_DELAYS = [0, 17, 7];

const NO_HISTORY: string[] = [];

/** A curated suggestion the user hasn't recently explored (random) — used when
 *  the AI recommendation is unavailable or comes back empty, so the button
 *  always produces something. */
function fallbackSuggestion(history: string[]): string {
  const seen = new Set(history.map((h) => h.toLowerCase()));
  const fresh = TOPIC_SUGGESTIONS.filter((t) => !seen.has(t.toLowerCase()));
  const pool = fresh.length ? fresh : TOPIC_SUGGESTIONS;
  return pool[Math.floor(Math.random() * pool.length)] ?? '';
}

/** Trim a recommendation reply down to a clean topic (a word, a few words, or a
 *  short sentence). Strips list/markdown noise and — crucially — any parenthetical
 *  rationale the model tacks on ("Noosphere (fits biology, systems…)"), plus any
 *  stray bracket left when that aside lost its opening paren. */
function cleanRecommendation(raw: string | null): string {
  if (!raw) return '';
  const first = raw.replace(/\r/g, '').split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  return first
    .replace(/^\s*([-*+•]|\d+[.)])\s+/, '')   // leading list marker
    .replace(/[`*]/g, '')                      // markdown emphasis
    .replace(/\([^)]*\)/g, '')                 // any (parenthetical rationale)
    .replace(/[()]/g, '')                      // stray unmatched parens
    .replace(/^["'“”«»]+|["'“”«».]+$/g, '')    // surrounding quotes / trailing period
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function WelcomeScreenB({ onOpenSettings, settingsOpen = false }: { onOpenSettings?: () => void; settingsOpen?: boolean }) {
  const { reduced: reducedMotion } = useDecorativeMotion();
  const [mode, setMode] = useState<StartMode>('chat');
  const [topic, setTopic] = useState('');
  const [chatPrompt, setChatPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [startError, setStartError] = useState('');
  const [recommending, setRecommending] = useState(false);
  const [dots, setDots] = useState('');
  const [recentPage, setRecentPage] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const closeEditor = useCallback(() => setEditorOpen(false), []);
  const importInputRef = useRef<HTMLInputElement>(null);
  const sourcePaneRef = useRef<HTMLElement>(null);
  const discardingDraftRef = useRef(false);
  const sourceManagerOpen = useSourceUiStore((state) => state.managerOpen);
  const openSourceManager = useSourceUiStore((state) => state.openManager);
  const closeSourceManager = useSourceUiStore((state) => state.closeManager);
  const topicDraft = useSourceUiStore((state) => state.topicDraft);
  const setTopicDraft = useSourceUiStore((state) => state.setTopicDraft);
  const [confirmDiscardSources, setConfirmDiscardSources] = useState(false);
  const [pendingTopic, setPendingTopic] = useState<{ text: string; mode: 'topic' | 'chat' } | null>(null);

  // Select STABLE references from the store (selecting a freshly-`.filter()`ed
  // array here would return a new reference every call and send
  // useSyncExternalStore into an infinite re-render loop). Derive in render.
  const projectList = useGraphStore((s) => s.projectList);
  const activeProjectId = useGraphStore((s) => s.activeProjectId);
  const activeProjectColor = useGraphStore((s) => s.project?.color);
  const pickerOpen = useGraphStore((s) => s.pickerOpen);
  const setPickerOpen = useGraphStore((s) => s.setPickerOpen);
  // Does the active project already have content? If so, the picker is overlaying
  // it — a topic should explore into a NEW project (created on submit), leaving
  // this one intact. If empty (first launch), explore in place.
  const activeHasNodes = useGraphStore((s) => !!s.project && Object.keys(s.project.nodes).length > 0);
  const previewingUncommittedProject = pickerOpen && activeHasNodes && !topicDraft;
  const otherProjects = projectList.filter((m) => m.id !== activeProjectId);
  // When opened as an overlay there's always the project behind to return to.
  const canClose = pickerOpen || otherProjects.length > 0;
  const sourceJobs = useSourceRuntimeStore((state) => state.jobs);
  const pendingSourceCount = previewingUncommittedProject ? 0 : Object.values(sourceJobs).filter((job) => (
    job.projectId === activeProjectId && job.status !== 'failed'
  )).length;

  const topicHistory = useSettingsStore((s) => s.topicHistory) ?? NO_HISTORY;
  const chatHistory = useSettingsStore((s) => s.chatStartHistory) ?? NO_HISTORY;
  const history = mode === 'chat' ? chatHistory : topicHistory;
  const pushTopic = useSettingsStore((s) => s.pushTopic);
  const pushChatStart = useSettingsStore((s) => s.pushChatStart);
  const removeTopic = useSettingsStore((s) => mode === 'chat' ? s.removeChatStart : s.removeTopic);
  const inputValue = mode === 'chat' ? chatPrompt : topic;
  const setInputValue = mode === 'chat' ? setChatPrompt : setTopic;

  // Opening the picker is navigation. Sources stay shared across tabs, but each
  // newly opened picker starts with their panel collapsed.
  useEffect(() => { closeSourceManager(); }, [closeSourceManager]);

  useEffect(() => {
    const pane = sourcePaneRef.current;
    if (!pane) return;
    if (sourceManagerOpen) pane.removeAttribute('inert');
    else pane.setAttribute('inert', '');
  }, [sourceManagerOpen]);
  const clearTopicHistory = useSettingsStore((s) => mode === 'chat' ? s.clearChatStartHistory : s.clearTopicHistory);
  const customPrompts = useSettingsStore((s) => s.customPrompts);

  // Shuffle once per open, then deal into 3 marquee rows (round-robin).
  const marqueeRows = useMemo(() => intoRows(shuffle(TOPIC_SUGGESTIONS), 3), []);

  // Pagination over the (most-recent-first) history, clamped if it shrinks.
  const pageCount = Math.max(1, Math.ceil(history.length / PAGE_SIZE));
  const page = Math.min(recentPage, pageCount - 1);
  const pageItems = history.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    const picker = pickerRef.current;
    if (editorOpen || settingsOpen) picker?.setAttribute('inert', '');
    else picker?.removeAttribute('inert');
    return () => picker?.removeAttribute('inert');
  }, [editorOpen, settingsOpen]);

  // Animated "thinking" dots shown as the field placeholder while recommending.
  useEffect(() => {
    if (!recommending) { setDots(''); return; }
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? '' : `${d}.`)), 300);
    return () => clearInterval(id);
  }, [recommending]);

  const finishStart = () => {
    setPickerOpen(false);
    closeSourceManager();
    setTopicDraft(null);
  };
  const explore = async (text: string, skipPendingSources = false, startMode: 'topic' | 'chat' = mode === 'chat' ? 'chat' : 'topic') => {
    const trimmed = text.trim();
    if (!trimmed || startingRef.current) return;
    startingRef.current = true; setStarting(true); setStartError('');
    try {
      // Preserve the project behind the picker; reuse a source draft if present.
      if (activeHasNodes) await createScatter();
      if (startMode === 'chat') {
        startChatRoot(trimmed, { skipPendingSources });
        pushChatStart(trimmed);
      } else {
        pushTopic(trimmed);
        void generateRoot(trimmed, { skipPendingSources });
      }
      finishStart();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Could not start the project. Try again.');
    } finally { startingRef.current = false; setStarting(false); }
  };

  const startImage = async (image: ProjectStartImage) => {
    if (startingRef.current) return;
    startingRef.current = true; setStarting(true); setStartError('');
    try {
      if (activeHasNodes) await createScatter();
      await startImageRoot(image);
      finishStart();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Could not start the image project. Try again.');
    } finally { startingRef.current = false; setStarting(false); }
  };

  const requestExplore = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (pendingSourceCount > 0) {
      setPendingTopic({ text: trimmed, mode: mode === 'chat' ? 'chat' : 'topic' });
      return;
    }
    void explore(trimmed);
  };
  const submit = () => { requestExplore(inputValue); };
  const handleSuggestion = (title: string) => {
    const prompt = mode === 'chat' ? `Tell me about: ${title}` : title;
    setInputValue(prompt); requestExplore(prompt);
  };
  const handleRecent = (q: string) => { setInputValue(q); requestExplore(q); };

  const handleRecommend = async () => {
    if (recommending) return;            // a second click during generation is a no-op
    setTopic('');                        // wipe any prior (recommended) text, then regenerate
    setRecommending(true);
    try {
      const pool = (history.length ? history : TOPIC_SUGGESTIONS).slice(0, 30);
      // Generous cap: reasoning-capable models spend tokens on internal
      // reasoning that counts against this budget, so a low cap returns a
      // truncated fragment (or nothing). 512 leaves ample room for the phrase.
      const raw = await oneShotCompletion(effectivePrompt('recommendSystem', customPrompts)
        + '\n\n' + generationLanguagePrompt(useSettingsStore.getState().generationLanguage),
      substitute(effectivePrompt('recommendTask', customPrompts), { topics: pool.join('\n') }), 512);
      // Always surface something — fall back to a fresh curated suggestion if the
      // model returns nothing usable (no provider, empty reply, etc.).
      setTopic(cleanRecommendation(raw) || fallbackSuggestion(history));
    } catch {
      setTopic(fallbackSuggestion(history));
    } finally {
      setRecommending(false);
    }
  };

  const discardTopicDraft = async () => {
    if (discardingDraftRef.current) return;
    const draft = useSourceUiStore.getState().topicDraft;
    setConfirmDiscardSources(false);
    closeSourceManager();
    if (!draft) {
      setPickerOpen(false);
      return;
    }
    discardingDraftRef.current = true;
    try {
      // Restore the exact project behind the picker first. The draft then
      // becomes an inactive project that can be deleted without deleteScatter
      // choosing and mounting an intermediate replacement of its own.
      const state = useGraphStore.getState();
      const returnProjectExists = state.projectList.some((item) => item.id === draft.returnProjectId);
      if (state.activeProjectId === draft.projectId && returnProjectExists) {
        await switchScatter(draft.returnProjectId);
      }
      await deleteScatter(draft.projectId);
      setTopicDraft(null);
      setPickerOpen(false);
    } catch (error) {
      console.error('[scatter] could not discard unfinished project:', error);
    } finally {
      discardingDraftRef.current = false;
    }
  };

  const handleClose = () => {
    if (startingRef.current) return;
    if (topicDraft && activeProjectId === topicDraft.projectId) {
      const sourceCount = Object.keys(useGraphStore.getState().project?.sourceLibrary?.sources ?? {}).length;
      const sourceJobs = Object.values(useSourceRuntimeStore.getState().jobs)
        .some((job) => job.projectId === topicDraft.projectId);
      if (sourceCount > 0 || sourceJobs) {
        setConfirmDiscardSources(true);
        return;
      }
      void discardTopicDraft();
      return;
    }
    // Overlay case: just close it — the project behind stays (delete nothing).
    if (pickerOpen) { setPickerOpen(false); closeSourceManager(); return; }
    // Genuine empty-project case: discard the empty active project and fall back
    // to the most-recently-updated remaining one.
    if (!canClose || !activeProjectId) return;
    void deleteScatter(activeProjectId);
  };

  return (
    <div
      className={'welcome welcome--picker' + (sourceManagerOpen ? ' has-source-manager' : '')}
      onClick={(e) => {
        // Clicking the backdrop (not the card) behaves like the X — but only
        // when closing is actually allowed (same condition as the X button).
        if (canClose && e.target === e.currentTarget) handleClose();
      }}
    >
      <div ref={pickerRef} aria-hidden={editorOpen || settingsOpen || undefined} className={`welcome-picker-frame${sourceManagerOpen ? ' sources-open' : ''}`}>
      <div className="welcome-start-tabs" role="tablist" aria-label="Start a project">
        {START_MODES.map((tab, index) => <button key={tab} type="button" role="tab" id={`start-tab-${tab}`}
          aria-label={mode === tab ? `Start with ${tab === 'image' ? 'an' : 'a'} ${tab}` : tab[0]!.toUpperCase() + tab.slice(1)}
          aria-selected={mode === tab} aria-controls="project-start-panel" tabIndex={mode === tab ? 0 : -1}
          disabled={starting || !!pendingTopic || confirmDiscardSources}
          className={`welcome-start-tab${mode === tab ? ' is-active' : ''}`}
          onClick={() => { setMode(tab); setRecentPage(0); setStartError(''); }}
          onKeyDown={(event) => {
            const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3
              : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
            if (next < 0) return;
            event.preventDefault(); setMode(START_MODES[next]!); setRecentPage(0); setStartError('');
            document.getElementById(`start-tab-${START_MODES[next]}`)?.focus();
          }}>
          <WelcomeTabShape />
          <span className="welcome-start-tab-prefix" aria-hidden="true"><span>{`Start with ${tab === 'image' ? 'an' : 'a'} `}</span></span>
          <span className="welcome-start-tab-name" aria-hidden="true">{tab}</span>
        </button>)}
      </div>
      <div className={`welcome-picker-shell${sourceManagerOpen ? ' sources-open' : ''}`}>
      <div className="welcome-card welcome-card--picker" role="tabpanel" id="project-start-panel" aria-labelledby={`start-tab-${mode}`}>
        {confirmDiscardSources && (
          <div className="source-draft-discard" role="dialog" aria-label="Discard added sources?">
            <strong>Discard added sources?</strong>
            <span>{pendingSourceCount > 0
              ? 'Some sources are still processing. Closing will cancel them and permanently remove this unfinished source project.'
              : 'They belong to this unfinished project and will be permanently removed.'}</span>
            <div>
              <button type="button" autoFocus onClick={() => setConfirmDiscardSources(false)}>Keep editing</button>
              <button type="button" className="destructive" onClick={() => { void discardTopicDraft(); }}>Discard</button>
            </div>
          </div>
        )}
        {pendingTopic && (
          <div className="source-draft-discard" role="dialog" aria-label="Sources are still processing">
            <strong>Sources are still processing</strong>
            <span>Wait for the complete source index, or start now using only sources that are ready.</span>
            <div>
              <button type="button" autoFocus onClick={() => setPendingTopic(null)}>Keep waiting</button>
              <button type="button" onClick={() => {
                const nextTopic = pendingTopic;
                setPendingTopic(null);
                void explore(nextTopic.text, true, nextTopic.mode);
              }}>Start now</button>
            </div>
          </div>
        )}
        <button
          type="button"
          className="welcome-close"
          disabled={!canClose || starting}
          onClick={handleClose}
          title={canClose ? 'Close' : 'No other project to return to'}
          aria-label="Close topic picker"
        >
          <X size={18} />
        </button>
        <button type="button" className="welcome-close welcome-settings" onClick={onOpenSettings}
          title="Settings" aria-label="Open settings" disabled={starting}>
          <Settings size={18} />
        </button>
        <div className="welcome-heading-row">
          <h1 className="welcome-tagline">
            {mode === 'chat' ? <>What’s on your <em>mind?</em></> : mode === 'image' ? <>What do you want to <em>look into?</em></>
              : <>What do you want to <em>explore?</em></>}
          </h1>
          {mode === 'topic' && <button
            type="button"
            className="topic-recommend"
            onClick={handleRecommend}
            disabled={recommending || history.length === 0}
            title={history.length === 0
              ? 'Explore a few topics first to get recommendations'
              : "Suggest a topic based on what you've explored"}
          >
            <Sparkles size={14} /> Recommend based on history
          </button>}
        </div>

        {mode !== 'image' && <div className="topic-row">
          <div className="topic-input-shell">
          <textarea
            autoFocus
            rows={2}
            className="topic-input"
            aria-label={mode === 'chat' ? 'First message' : 'Topic or question'}
            value={inputValue}
            readOnly={starting || (mode === 'topic' && recommending)}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
            }}
            placeholder={mode === 'chat' ? 'Start a conversation…' : recommending ? `Thinking${dots}` : 'A topic or a question…'}
          />
          <button ref={expandButtonRef} type="button" className="topic-expand" disabled={starting || (mode === 'topic' && recommending)}
            onClick={() => setEditorOpen(true)} aria-label={mode === 'chat' ? 'Expand message editor' : 'Expand topic editor'} title="Expand editor">
            <Maximize2 size={16} />
          </button>
          </div>
          <button
            type="button"
            className="topic-go"
            disabled={!inputValue.trim() || starting || (mode === 'topic' && recommending)}
            onClick={submit}
            aria-label={mode === 'chat' ? 'Start conversation' : 'Submit topic'}
          >
            <ArrowRight size={18} strokeWidth={2} />
          </button>
        </div>}

        <div className="topic-actions">
          <div className="topic-source-controls">
            <SourceControls disabled={starting} emptyAction="manager" virtualEmpty={previewingUncommittedProject} />
          </div>
          {/* Same model switcher + web-search toggle as the side panel, on the
              right at the same level as Recommend. Opens downward (near the top). */}
          {mode !== 'image' && <div className="topic-modelpicker">
            <SidebarModelPicker placement="down" />
          </div>}
        </div>

        {startError && <p className="image-project-error" role="alert">{startError}</p>}
        <ImageProjectInput active={mode === 'image'} busy={starting} onStart={(image) => { void startImage(image); }} />
        <div className="topic-picker-browse" hidden={mode === 'image'}>
        <div className="welcome-section-label"><span>{mode === 'chat' ? 'Tell me about' : 'Try one'}</span></div>
        <div className="suggest-marquee">
          {marqueeRows.map((row, ri) => (
            <div className="marquee-row" key={ri}>
              <div
                className="marquee-track"
                style={{
                  // Duration scales with the row's pill count → constant speed.
                  animationDuration: `${row.length * (ROW_SECS_PER_ITEM[ri] ?? 9)}s`,
                  animationDelay: `-${ROW_DELAYS[ri]}s`,
                  animationPlayState: reducedMotion ? 'paused' : 'running',
                  // Overrides the pre-hydration system CSS only after the hook resolves.
                  animationName: 'marquee-left',
                }}
              >
                {[...row, ...row].map((title, ti) => (
                  <button
                    key={ti}
                    type="button"
                    className="suggest-pill"
                    disabled={starting}
                    onClick={() => handleSuggestion(title)}
                    tabIndex={-1}
                  >
                    {title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="welcome-section-label"><span>History</span></div>
        <div className="recent-list">
          <div className="recent-rows">
            {history.length === 0 ? <p className="recent-query recent-empty">No history yet.</p> : pageItems.map((q) => (
              <div
                key={q}
                className={'recent-row' + (activeProjectColor ? ' has-accent' : '')}
                style={activeProjectColor
                  ? { '--row-accent': colorToCss(activeProjectColor) } as React.CSSProperties
                  : undefined}
                role="button"
                tabIndex={0}
                onClick={() => handleRecent(q)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handleRecent(q);
                  }
                }}
                title={mode === 'chat' ? `Start a conversation with "${q}"` : `Explore "${q}" again`}
              >
                <span className="recent-query">
                  {q}
                </span>
                <span className="recent-row-actions" onPointerDown={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="sidebar-row-action recent-row-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeTopic(q);
                    }}
                    aria-label={`Remove "${q}" from history`}
                    title="Remove from history"
                  >
                    <X size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="recent-footer">
            {pageCount > 1 && (
              <div className="recent-pager">
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setRecentPage(page - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={12} />
                </button>
                <span>{page + 1} / {pageCount}</span>
                <button
                  type="button"
                  disabled={page >= pageCount - 1}
                  onClick={() => setRecentPage(page + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight size={12} />
                </button>
              </div>
            )}
            {history.length > 0 && <button
              type="button"
              className="recent-clear"
              onClick={() => { clearTopicHistory(); setRecentPage(0); }}
              title="Remove all recently explored"
            >
              Remove all
            </button>}
          </div>
        </div>

        <div className="welcome-section-label"><span>Or</span></div>
        <div className="welcome-row" style={{ justifyContent: 'flex-start' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => importInputRef.current?.click()}
          >
            <Download size={13} /> Import project from file
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';       // allow re-picking the same file later
              if (!file) return;
              void importScatterFromFile(file)
                .then(() => setPickerOpen(false))   // imported scatter is active behind the picker
                .catch((err) => {
                  console.error('[scatter] import failed:', err);
                  alert(err instanceof ProjectImportError
                    ? err.message
                    : 'Import failed — that file doesn’t look like a Scatter project export.');
                });
            }}
          />
        </div>
        </div>
      </div>
      <div className="welcome-source-divider">
        <button
          type="button"
          onClick={sourceManagerOpen ? closeSourceManager : openSourceManager}
          aria-label={sourceManagerOpen ? 'Hide project sources' : 'Show project sources'}
          data-tip={sourceManagerOpen ? 'Hide project sources' : 'Show project sources'}
        >
          {sourceManagerOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>
      <aside ref={sourcePaneRef} className="welcome-source-pane" aria-hidden={!sourceManagerOpen}>
        <SourceManager embedded virtualEmpty={previewingUncommittedProject} />
      </aside>
      </div>
      </div>
      {editorOpen && <TopicInputWindow value={inputValue} onChange={setInputValue} onClose={closeEditor}
        mode={mode === 'chat' ? 'chat' : 'topic'}
        returnFocusRef={expandButtonRef}
        onSubmit={() => { closeEditor(); submit(); }} />}
    </div>
  );
}
