'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CloudSync, PanelLeftClose, PanelLeftOpen, Search,
  ChevronDown, ChevronRight, LoaderCircle, Pencil, Pin, PinOff, Plus, Trash2, X,
} from 'lucide-react';
import { NavActions } from './NavActions';
import { SidebarShortcuts } from './SidebarShortcuts';
import { SidebarModelPicker } from './SidebarModelPicker';
import { SidebarWordmark } from './SidebarWordmark';
import { OfflineIndicator } from './OfflineIndicator';
import { useGraphStore } from '@/store/useGraphStore';
import {
  switchScatter, renameScatter, deleteScatter, reorderProjects,
  recolorScatter, ensureScatterColorInMeta,
} from '@/store/projectActions';
import { buildSearchIndex, searchNodes, splitByRanges, type SearchResult } from '@/lib/searchNodes';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { activateChatAnswer } from '@/lib/chat/actions';
import { splitListHeights } from '@/lib/splitListHeights';
import { isClickAwayFromRow } from '@/lib/anchoredPanel';
import { colorToCss } from '@/lib/groupColor';
import { sidebarDragScrollStep } from '@/lib/sidebarDragScroll';
import {
  DEFAULT_SIDEBAR_DISCLOSURES,
  readSidebarDisclosures,
  writeSidebarDisclosures,
  type SidebarDisclosureState,
} from '@/lib/sidebarPreferences';
import { GroupColorEditor } from '@/components/GroupColorEditor';
import { GroupTitleText } from '@/components/GroupTitleText';
import { Minimap } from '@/components/canvas/Minimap';
import type { Group, GroupColor, ProjectMeta, ScatterNode } from '@/store/types';
import { useSyncStore } from '@/store/useSyncStore';
import { useProjectSyncLabelStore } from '@/store/useProjectSyncLabelStore';
import { syncStatusLabel } from '@/sync/actions';
import { requestSyncNow } from '@/sync/coordinator';
import { hasSyncConnection } from '@/sync/connection';
import { SourceControls } from '@/components/sources/SourceControls';
import type { SettingsPageId } from './settings/settingsNavigation';

interface Props {
  /** Persistent collapse intent. */
  collapsed: boolean;
  /** Transient hover-reveal: while true the panel is shown even though
   *  `collapsed` is true. */
  peeking?: boolean;
  onToggle: () => void;
  onOpenSettings: (page?: SettingsPageId) => void;
  /** Prevent an auto-hidden sidebar from retracting while a floating control
   * that belongs to it is in use. */
  onPeekLockChange?: (locked: boolean) => void;
}

/** Two animation frames: the first lets React commit the loading layer, the
 * second starts expensive project work only after the browser has painted it. */
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function Sidebar({ collapsed, peeking, onToggle, onOpenSettings, onPeekLockChange }: Props) {
  // Slid off-screen only when collapsed AND not peeking. While peeking, the
  // full panel is shown even though the persistent intent is "collapsed".
  const hidden = collapsed && !peeking;
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  // The Projects + Groups lists share their wrapper's height (see the hook at
  // the bottom of this file); the wrapper only exists while the sidebar is open.
  const listsRef = useRef<HTMLDivElement>(null);
  const [disclosures, setDisclosures] = useState<SidebarDisclosureState>(DEFAULT_SIDEBAR_DISCLOSURES);
  useEffect(() => {
    setDisclosures(readSidebarDisclosures());
  }, []);
  const setDisclosure = useCallback((section: keyof SidebarDisclosureState, open: boolean) => {
    setDisclosures((current) => {
      const next = { ...current, [section]: open };
      writeSidebarDisclosures(next);
      return next;
    });
  }, []);
  const ensureProjectsOpen = useCallback(() => setDisclosure('projects', true), [setDisclosure]);
  const ensureGroupsOpen = useCallback(() => setDisclosure('groups', true), [setDisclosure]);
  useBalancedListHeights(listsRef, !hidden, disclosures.projects, disclosures.groups);
  // Query lives in the store so node text can highlight matches and a canvas
  // click can reset it; the keyboard cursor stays local to the sidebar.
  const query = useGraphStore((s) => s.searchQuery);
  const setQuery = useGraphStore((s) => s.setSearchQuery);
  const [active, setActive] = useState(0);
  const trimmed = query.trim();

  // Rebuild the fuzzy index ONLY when searchable text changes — never on the
  // position-only `project.nodes` churn every physics tick. The signature is
  // a cheap O(N) string (ids + version index + text lengths); zustand only
  // re-renders us when it actually differs.
  const sig = useGraphStore((s) => searchSignature(s.project?.nodes));
  const previewSignature = useChatRuntimeStore((s) => Object.entries(s.views).map(([id, view]) => `${id}:${JSON.stringify(view.previews)}`).join('|'));
  const index = useMemo(() => {
    const rec = useGraphStore.getState().project?.nodes;
    return buildSearchIndex(rec ? Object.values(rec) : [], useChatRuntimeStore.getState().views);
  }, [sig, previewSignature]);
  const results = useMemo(
    () => (trimmed ? searchNodes(index, trimmed) : []),
    [index, trimmed],
  );

  // New result set → reset the keyboard cursor to the top.
  useEffect(() => { setActive(0); }, [results]);
  // Keep the active row visible as the cursor moves.
  useEffect(() => {
    resultsRef.current
      ?.querySelector('.search-result.active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Focus a result's node + smoothly fly the camera to it (same as a node
  // click). Selecting it fires the focus ripple immediately (sceneState); the
  // camera then pans. For an off-screen result the ripple plays during the pan
  // (snappy, tied to focus — not deferred to arrival).
  const openResult = (result: SearchResult) => {
    const nodeId = result.nodeId;
    if (result.sourceAnswer) {
      const node = useGraphStore.getState().project?.nodes[nodeId];
      if (!node?.versions.some((version) => version.createdAt === result.sourceAnswer?.versionCreatedAt
        && version.chat?.turnId === result.sourceAnswer.turnId)) return;
      activateChatAnswer(nodeId, result.sourceAnswer);
      useChatRuntimeStore.getState().jumpTo(nodeId, result.sourceAnswer.turnId, trimmed);
    }
    useGraphStore.getState().setSelection([nodeId]);
    useGraphStore.getState().requestPanTo(nodeId);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
      searchRef.current?.blur();
      return;
    }
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[active] ?? results[0];
      if (r) openResult(r);
    }
  };

  return (
    <aside className={'sidebar' + (hidden ? ' collapsed' : '')}>
      {/* Header: left-aligned pixel wordmark + in-panel collapse control. */}
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <SidebarWordmark />
          <OfflineIndicator />
        </div>
        {!hidden && (
          <button
            type="button"
            onClick={onToggle}
            data-tip={collapsed ? 'Keep sidebar open' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Keep sidebar open' : 'Collapse sidebar'}
            className="sidebar-toggle"
          >
            {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>
        )}
      </div>

      {/* Search */}
      {!hidden && (
        <div className="search-wrap">
          <span className="search-icon"><Search size={13} /></span>
          <input
            ref={searchRef}
            className="search-input"
            type="text"
            placeholder="Search nodes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <button
            type="button"
            className="search-clear"
            onClick={() => {
              setQuery('');
              searchRef.current?.blur();
            }}
            aria-label="Close search"
            data-tip="Close search"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Search results — bounded, scrollable; pushes the sections below down */}
      {!hidden && trimmed.length > 0 && (
        <div className="search-results" ref={resultsRef}>
          <div className="search-results-caption">
            {results.length === 0
              ? 'No matches'
              : `${results.length} result${results.length === 1 ? '' : 's'}`}
          </div>
          {results.map((r, i) => (
            <button
              key={`${r.nodeId}:${r.sourceAnswer?.turnId ?? ''}`}
              type="button"
              className={'search-result' + (i === active ? ' active' : '')}
              onClick={() => openResult(r)}
              onMouseEnter={() => setActive(i)}
              data-tip="Focus this node and pan the camera to it"
            >
              <div className="search-result-title">
                <span className="search-result-title-text">
                  {renderRanges(r.title || 'Untitled', r.titleRanges)}
                </span>
              </div>
              {r.fragments.map((f, fi) =>
                f.text ? (
                  <div key={fi} className="search-result-snippet">
                    {renderRanges(f.text, f.ranges)}
                  </div>
                ) : null,
              )}
            </button>
          ))}
        </div>
      )}

      {/* Projects + Groups. Each list scrolls independently when it overflows:
          a short list yields its unused height to the long one; two long lists
          split the leftover space evenly. This wrapper also fills the middle of
          the sidebar, pinning the footer cluster below (it replaces the old
          .sidebar-spacer). */}
      {!hidden && (
        <div className="sidebar-lists" ref={listsRef}>
          {/* Projects — the list of all projects, active one highlighted */}
          <SidebarProjects
            open={disclosures.projects}
            onToggle={() => setDisclosure('projects', !disclosures.projects)}
            onEnsureOpen={ensureProjectsOpen}
            onPeekLockChange={onPeekLockChange}
            onOpenSettings={onOpenSettings}
          />
          {/* Groups (B.3) */}
          <SidebarGroups
            open={disclosures.groups}
            onToggle={() => setDisclosure('groups', !disclosures.groups)}
            onEnsureOpen={ensureGroupsOpen}
          />
        </div>
      )}

      {/* Context-aware shortcut hints — what the user can do RIGHT NOW
          given the focused node / temporal state. Sits just above the
          footer's nav buttons, hidden when the sidebar is collapsed
          to a narrow strip. */}
      {!hidden && (
        <div className="sidebar-shortcuts-section">
          <button
            type="button"
            className="sidebar-shortcuts-title"
            onClick={() => setDisclosure('shortcuts', !disclosures.shortcuts)}
            aria-expanded={disclosures.shortcuts}
            aria-controls="sidebar-shortcuts-body"
            aria-label="Shortcuts"
          >
            {disclosures.shortcuts ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Shortcuts</span>
          </button>
          {disclosures.shortcuts && (
            <div id="sidebar-shortcuts-body"><SidebarShortcuts /></div>
          )}
        </div>
      )}

      {/* Project overview minimap — above the model picker / nav buttons. */}
      {!hidden && <Minimap />}

      {/* One compact control panel matching the collapsed-sidebar toolbar,
          with its row order inverted: model/search above navigation. */}
      {!hidden && (
        <div className="sidebar-control-panel">
          <SidebarModelPicker placement="up" variant="toolbar" onReasoningOpenChange={onPeekLockChange} />
          <SourceControls />
          <div className="sidebar-footer">
            <NavActions onOpenSettings={() => onOpenSettings()} />
          </div>
        </div>
      )}
    </aside>
  );
}

/** Render a string with its Fuse match ranges bolded. */
function renderRanges(text: string, ranges: [number, number][]) {
  return splitByRanges(text, ranges).map((seg, i) =>
    seg.bold
      ? <strong key={i}>{seg.text}</strong>
      : <span key={i}>{seg.text}</span>,
  );
}

/** Cheap O(N) signature of all searchable text. Changes when nodes are
 *  added/removed, a version is added or switched, or the current version's
 *  header/body length changes (covers streaming + edits) — but NOT on the
 *  position-only `project.nodes` churn every physics tick. Used as the
 *  Fuse-index rebuild key so the index is stable while the graph settles. */
function searchSignature(nodes?: Record<string, ScatterNode>): string {
  if (!nodes) return '';
  const ids = Object.keys(nodes);
  let s = ids.length + ';';
  for (const id of ids) {
    const n = nodes[id];
    if (!n) continue;
    const v = n.versions[n.currentVersionIndex];
    if (n.chat) {
      s += `${id}:${n.chat.title}:${n.chat.turns.map((turn) => turn.selectedVersionCreatedAt).join(',')}:`;
      for (const answer of n.versions) if (answer.chat) s += `${answer.createdAt}:${searchVersionIdentity(answer)}:${answer.chat.title}:${answer.chat.question}|`;
      continue;
    }
    s += `${id}:${n.currentVersionIndex}:${n.versions.length}:${v?.header.length ?? 0}:${v?.body.length ?? 0}|`;
  }
  return s;
}

const searchableVersions = new WeakMap<object, number>();
let nextSearchVersionIdentity = 0;
function searchVersionIdentity(version: object): number {
  let id = searchableVersions.get(version);
  if (id == null) { id = ++nextSearchVersionIdentity; searchableVersions.set(version, id); }
  return id;
}

function SidebarProjectSyncButton({ onOpenSettings }: Pick<Props, 'onOpenSettings'>) {
  const [clickFeedback, setClickFeedback] = useState(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useSyncStore((state) => state.running);
  const error = useSyncStore((state) => state.error);
  const automatic = useSyncStore((state) => state.config.enabled);
  const connected = useSyncStore((state) => hasSyncConnection(state.config));
  const syncing = connected && running;
  const pulsing = connected && (running || clickFeedback);
  useEffect(() => () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current); }, []);
  useEffect(() => {
    if (connected) return;
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setClickFeedback(false);
  }, [connected]);
  const tooltip = !connected ? 'Sync not connected. Open sync settings.'
    : syncing ? 'Syncing projects and settings…'
      : error ? (automatic ? 'Sync failed. Click to retry.' : 'Sync failed. Retry once; stay paused.')
        : automatic ? 'Sync projects and settings'
          : 'Sync projects and settings once; automatic syncing stays paused.';

  return (
    <button
      type="button"
      className={'sidebar-section-add sidebar-sync-button'
        + (pulsing ? ' syncing' : '') + (!connected || error ? ' failed' : '')}
      onClick={() => {
        if (!connected) {
          onOpenSettings('sync');
          return;
        }
        setClickFeedback(true);
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        // Two complete 1.25s CSS pulse cycles, without delaying the real job.
        feedbackTimer.current = setTimeout(() => setClickFeedback(false), 2_500);
        void requestSyncNow({ manual: true }).catch((cause) => {
          // The coordinator reports provider failures itself. A lock or
          // setup failure can happen before it starts, so report that too.
          if (!useSyncStore.getState().error) {
            useSyncStore.getState().setRuntime({
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        });
      }}
      disabled={syncing}
      aria-busy={syncing || undefined}
      aria-label={!connected ? 'Open synchronization settings' : syncing ? 'Syncing projects and settings' : error ? 'Retry syncing projects and settings' : 'Sync projects and settings'}
      data-tip={tooltip}
    >
      <CloudSync size={16} />
    </button>
  );
}

/**
 * Sidebar Projects section — the multi-project list.
 *
 * Mirrors the Groups section's visual language: one `.sidebar-row` per scatter
 * (active one highlighted), inline rename + recolor (pencil), two-step-confirm
 * delete (trash), and a centered "+" button that creates a new project and
 * switches to it. Rows tint with the project's base color (--row-accent, from
 * the ProjectMeta mirror / live store) — same treatment as group rows.
 */
function SidebarProjects({
  open,
  onToggle,
  onEnsureOpen,
  onPeekLockChange,
  onOpenSettings,
}: {
  open: boolean;
  onToggle: () => void;
  onEnsureOpen: () => void;
  onPeekLockChange?: (locked: boolean) => void;
  onOpenSettings: Props['onOpenSettings'];
}) {
  const projectList = useGraphStore((s) => s.projectList);
  const projectIds = useMemo(() => projectList.map((project) => project.id), [projectList]);
  const activeProjectId = useGraphStore((s) => s.activeProjectId);
  const activeProject = projectList.find((project) => project.id === activeProjectId) ?? null;
  const hiddenCount = Math.max(0, projectList.length - (activeProject ? 1 : 0));
  const disclosureDisabled = projectList.length === 1;
  const [switchingProjectId, setSwitchingProjectId] = useState<string | null>(null);
  const switchingRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const moveProject = useCallback((fromId: string, toId: string) => {
    void reorderProjects(fromId, toId);
  }, []);
  const deleteProject = useCallback(async (project: ProjectMeta) => {
    const state = useGraphStore.getState();
    const remaining = state.projectList.filter((candidate) => candidate.id !== project.id);
    const replacement = state.activeProjectId === project.id && remaining.length > 0
      ? remaining.reduce((latest, candidate) => (
          candidate.updatedAt > latest.updatedAt ? candidate : latest
        ))
      : null;

    if (replacement) {
      switchingRef.current = replacement.id;
      setSwitchingProjectId(replacement.id);
      // Match ordinary project switching: let the replacement row and spinner
      // paint before deletion/loading work can occupy the main thread.
      await afterNextPaint();
    }

    try {
      await deleteScatter(project.id);
    } finally {
      if (replacement && switchingRef.current === replacement.id) {
        switchingRef.current = null;
      }
      if (mountedRef.current) setSwitchingProjectId(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (disclosureDisabled && !open) onEnsureOpen();
  }, [disclosureDisabled, onEnsureOpen, open]);

  const openProject = useCallback((project: ProjectMeta) => {
    if (project.id === activeProjectId || switchingRef.current) return;
    switchingRef.current = project.id;
    setSwitchingProjectId(project.id);

    void afterNextPaint()
      .then(() => {
        if (!mountedRef.current || switchingRef.current !== project.id) return;
        return switchScatter(project.id);
      })
      .catch((error) => console.error('[scatter] project switch failed:', error))
      .finally(() => {
        switchingRef.current = null;
        if (!mountedRef.current) return;
        setSwitchingProjectId(null);
      });
  }, [activeProjectId]);

  const projectRow = (project: ProjectMeta, active: boolean, preview = false) => (
    <SidebarProjectRow
      key={project.id}
      project={project}
      active={active}
      preview={preview}
      interactionsDisabled={switchingProjectId != null}
      switching={switchingProjectId === project.id}
      showSpinner={switchingProjectId === project.id}
      onOpen={() => openProject(project)}
      onDelete={deleteProject}
      onDeletePromptOpenChange={onPeekLockChange}
    />
  );

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title">
        <button
          type="button"
          className="sidebar-section-toggle"
          onClick={() => { if (!disclosureDisabled) onToggle(); }}
          aria-disabled={disclosureDisabled || undefined}
          tabIndex={disclosureDisabled ? -1 : undefined}
          data-tip={disclosureDisabled ? 'A single project cannot be collapsed' : undefined}
          aria-expanded={open}
          aria-controls="sidebar-projects-body"
          aria-label="Projects"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>Projects</span>
        </button>
        <div className="sidebar-section-actions">
          <SidebarProjectSyncButton onOpenSettings={onOpenSettings} />
          <button
            type="button"
            className="sidebar-section-add"
            onClick={() => {
              // Keep the current project mounted until the user commits a topic
              // or source. Creating a real project here exposed the blank canvas
              // before its draft marker existed, so a quick Close could race the
              // unfinished creation and resurrect an empty project.
              useGraphStore.getState().setPickerOpen(true);
            }}
            data-tip="Start new project"
            aria-label="Start new project"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
      <SidebarSortableRows
        ids={projectIds}
        disabled={!open || switchingProjectId != null}
        onMove={moveProject}
        scrollContainerId="sidebar-projects-body"
      >
        <div
          id="sidebar-projects-body"
          className={'sidebar-section-body' + (open ? '' : ' sidebar-collapsed-preview')}
        >
          {open
            ? projectList.map((p) => (
                projectRow(p, p.id === activeProjectId)
              ))
            : activeProject && (
                <>
                  {projectRow(activeProject, true, true)}
                  <SidebarMoreButton count={hiddenCount} item="project" onClick={onToggle} />
                </>
              )}
        </div>
      </SidebarSortableRows>
    </div>
  );
}

/**
 * Shared inline-rename behavior for sidebar rows.
 *   - focus the field when editing opens (caret lands, text is NOT auto-selected
 *     so a stray keystroke can't wipe the whole name)
 *   - Enter commits, Esc cancels (handled by the caller's input)
 *   - clicking ANYWHERE outside the row commits + exits. A group's color
 *     panel counts as INSIDE even though it's portaled to document.body
 *     (isClickAwayFromRow) — so picking a swatch doesn't blur-commit and
 *     close the panel.
 * The row uses `rowRef` as the click-away boundary.
 */
function useRowEdit(currentName: string, onCommit: (name: string) => void) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentName);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  const commit = () => {
    const t = draft.trim();
    if (t && t !== currentName) onCommit(t);
    else setDraft(currentName);
    setEditing(false);
  };
  // Live ref so the click-away listener always calls the latest commit.
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      if (isClickAwayFromRow(rowRef.current, e.target)) commitRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [editing]);

  const begin = () => { setDraft(currentName); setEditing(true); };
  const cancel = () => { setDraft(currentName); setEditing(false); };
  return { editing, draft, setDraft, inputRef, rowRef, commit, begin, cancel };
}

/** Shared vertical-sort context for the independently scrollable project and
 * group lists. Dnd Kit supplies pointer + keyboard sorting and moves sibling
 * rows with transforms while its auto-scroller advances only the active list. */
function SidebarSortableRows({
  ids,
  disabled,
  onMove,
  onSortStart,
  scrollContainerId,
  children,
}: {
  ids: string[];
  disabled: boolean;
  onMove: (fromId: string, toId: string) => void;
  onSortStart?: () => void;
  scrollContainerId: string;
  children: React.ReactNode;
}) {
  const scrollFrameRef = useRef(0);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const pointerYRef = useRef(0);
  const maxScrollTopRef = useRef(0);
  const pointerMoveRef = useRef<((event: PointerEvent) => void) | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const stopAutoScroll = useCallback(() => {
    if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = 0;
    scrollElementRef.current = null;
    maxScrollTopRef.current = 0;
    if (pointerMoveRef.current) {
      window.removeEventListener('pointermove', pointerMoveRef.current);
      pointerMoveRef.current = null;
    }
  }, []);

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const onDragStart = useCallback((event: DragStartEvent) => {
    onSortStart?.();
    stopAutoScroll();
    if (!(event.activatorEvent instanceof PointerEvent)) return;

    const element = document.getElementById(scrollContainerId);
    if (!element) return;
    // Capture the genuine range before sortable transforms can make the
    // dragged row contribute artificial overflow.
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    if (maxScrollTop <= 1) return;

    scrollElementRef.current = element;
    maxScrollTopRef.current = maxScrollTop;
    pointerYRef.current = event.activatorEvent.clientY;
    const onPointerMove = (pointerEvent: PointerEvent) => {
      pointerYRef.current = pointerEvent.clientY;
    };
    pointerMoveRef.current = onPointerMove;
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    const scrollFrame = () => {
      const current = scrollElementRef.current;
      if (!current) return;
      const rect = current.getBoundingClientRect();
      const step = sidebarDragScrollStep({
        pointerY: pointerYRef.current,
        viewportTop: rect.top,
        viewportBottom: rect.bottom,
        scrollTop: current.scrollTop,
        maxScrollTop: maxScrollTopRef.current,
      });
      if (step !== 0) current.scrollTop += step;
      scrollFrameRef.current = requestAnimationFrame(scrollFrame);
    };
    scrollFrameRef.current = requestAnimationFrame(scrollFrame);
  }, [onSortStart, scrollContainerId, stopAutoScroll]);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    stopAutoScroll();
    const fromId = String(event.active.id);
    const toId = event.over ? String(event.over.id) : '';
    if (toId && fromId !== toId) onMove(fromId, toId);
  }, [onMove, stopAutoScroll]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      autoScroll={false}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={stopAutoScroll}
    >
      <SortableContext
        items={ids}
        strategy={verticalListSortingStrategy}
        disabled={disabled}
      >
        {children}
      </SortableContext>
    </DndContext>
  );
}

function useSortableSidebarRow(
  id: string,
  disabled: boolean,
  rowRef: React.MutableRefObject<HTMLDivElement | null>,
) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled,
    transition: { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  });
  const setRowRef = useCallback((node: HTMLDivElement | null) => {
    rowRef.current = node;
    setNodeRef(node);
  }, [rowRef, setNodeRef]);
  return {
    setRowRef,
    sortableProps: disabled ? {} : { ...attributes, ...listeners },
    sortableStyle: {
      transform: CSS.Transform.toString(transform),
      transition,
      zIndex: isDragging ? 2 : undefined,
    } satisfies React.CSSProperties,
    isDragging,
  };
}

function SidebarProjectRow({
  project,
  active,
  preview = false,
  interactionsDisabled = false,
  switching = false,
  showSpinner = false,
  onOpen,
  onDelete,
  onDeletePromptOpenChange,
}: {
  project: ProjectMeta;
  active: boolean;
  preview?: boolean;
  interactionsDisabled?: boolean;
  switching?: boolean;
  showSpinner?: boolean;
  onOpen?: () => void;
  onDelete?: (project: ProjectMeta) => Promise<void>;
  onDeletePromptOpenChange?: (open: boolean) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [syncHovered, setSyncHovered] = useState(false);
  const syncLabel = useSyncStore((state) => syncStatusLabel(project.id, state));
  const mountedRef = useRef(true);
  const { editing, draft, setDraft, inputRef, rowRef, commit, begin, cancel } =
    useRowEdit(project.name, (name) => void renameScatter(project.id, name));
  const sortDisabled = editing || preview || interactionsDisabled || deleting;
  const { setRowRef, sortableProps, sortableStyle, isDragging } = useSortableSidebarRow(
    project.id,
    sortDisabled,
    rowRef,
  );
  // The row's color: live store color for the ACTIVE project (updates during
  // recolor without waiting for the registry mirror), the ProjectMeta mirror
  // for the rest. Null only for rows last opened before colors existed —
  // those self-heal via ensureScatterColorInMeta when edited (or when opened).
  const projectColor = useGraphStore(
    (s) => (active ? s.project?.color ?? null : null) ?? project.color ?? null,
  );

  useEffect(() => {
    const labels = useProjectSyncLabelStore.getState();
    if (!syncLabel || !syncHovered || isDragging || editing) {
      labels.clear(project.id);
      return;
    }
    let frame = 0;
    const update = () => {
      const row = rowRef.current?.getBoundingClientRect();
      if (!row) return;
      useProjectSyncLabelStore.getState().show({
        projectId: project.id,
        text: syncLabel,
        accent: projectColor,
        anchorViewportY: row.top + row.height / 2,
      });
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('resize', scheduleUpdate);
    document.addEventListener('scroll', scheduleUpdate, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleUpdate);
      document.removeEventListener('scroll', scheduleUpdate, true);
      useProjectSyncLabelStore.getState().clear(project.id);
    };
  }, [editing, isDragging, project.id, projectColor, rowRef, syncHovered, syncLabel]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (preview) setConfirmDelete(false);
  }, [preview]);

  useEffect(() => {
    if (!confirmDelete) return;
    onDeletePromptOpenChange?.(true);
    return () => onDeletePromptOpenChange?.(false);
  }, [confirmDelete, onDeletePromptOpenChange]);

  // Switching to a project that's scrolled out of the (independently scrollable)
  // Projects list should reveal it. `block: 'nearest'` leaves already-visible
  // rows put, so it only scrolls when the active row is actually off-screen.
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div
      ref={setRowRef}
      {...sortableProps}
      className={'sidebar-row' + (projectColor ? ' has-accent' : '') + (active ? ' active' : '') + (editing ? ' editing' : '') + (isDragging ? ' sorting' : '') + (switching ? ' switching' : '')}
      aria-busy={switching || undefined}
      // The project's color tints the whole tab, same treatment as group rows.
      style={{
        position: 'relative',
        ...sortableStyle,
        ...(projectColor ? { ['--row-accent']: colorToCss(projectColor) } : {}),
      } as React.CSSProperties}
      onClick={() => {
        if (editing || interactionsDisabled || active) return;
        if (onOpen) onOpen();
        else void switchScatter(project.id);
      }}
      onPointerEnter={() => setSyncHovered(true)}
      onPointerLeave={() => setSyncHovered(false)}
      onFocus={() => setSyncHovered(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setSyncHovered(false);
      }}
      data-tip="Open this project"
    >
      {editing ? (
        <input
          ref={inputRef}
          className="row-name row-name-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
        />
      ) : (
        <span className="row-name">{project.name}</span>
      )}

      {showSpinner && (
        <span
          className="project-switch-spinner"
          role="status"
          aria-label={`Opening ${project.name}`}
        >
          <LoaderCircle size={14} aria-hidden="true" />
        </span>
      )}

      <span className="sidebar-row-actions" onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="sidebar-row-action"
          disabled={interactionsDisabled}
          data-tip="Rename & recolor project"
          onClick={(e) => {
            e.stopPropagation();
            // Editing opens the floating color panel — drop any focused node
            // so its side/follow-up panels don't compete with it.
            useGraphStore.getState().setSelection([]);
            // Registry rows from before project colors existed have no color
            // yet — backfill it so the picker below has a `current` to show.
            if (!active && !project.color) void ensureScatterColorInMeta(project.id);
            begin();
          }}
          style={iconBtnStyle(editing)}
          aria-label={`Edit ${project.name}`}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className="sidebar-row-action"
          disabled={interactionsDisabled || deleting}
          data-tip="Delete project"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDelete(true);
          }}
          style={iconBtnStyle(false)}
          aria-label={`Delete ${project.name}`}
        >
          <Trash2 size={13} />
        </button>
      </span>

      {confirmDelete && (
        <ProjectDeleteConfirmation
          project={project}
          projectColor={projectColor}
          anchorRef={rowRef}
          deleting={deleting}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            if (deleting) return;
            setDeleting(true);
            void (onDelete ? onDelete(project) : deleteScatter(project.id))
              .catch((error) => {
                console.error('[scatter] project deletion failed:', error);
              })
              .finally(() => {
                if (!mountedRef.current) return;
                setDeleting(false);
                setConfirmDelete(false);
              });
          }}
        />
      )}

      {/* Base-color panel — same floating editor groups use, on EVERY row.
          recolorScatter routes: active → undoable store action; non-active →
          rewrite the project file + registry row. */}
      {editing && projectColor && (
        <GroupColorEditor
          current={projectColor}
          onPick={(c) => void recolorScatter(project.id, c)}
          anchorRef={rowRef}
        />
      )}
    </div>
  );
}

function ProjectDeleteConfirmation({
  project,
  projectColor,
  anchorRef,
  deleting,
  onCancel,
  onConfirm,
}: {
  project: ProjectMeta;
  projectColor: GroupColor | null;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const noRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    noRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    let raf = 0;
    const place = () => {
      const row = anchorRef.current;
      const panel = panelRef.current;
      if (row && panel) {
        const anchor = row.getBoundingClientRect();
        const clip = row.closest('.sidebar-section-body')?.getBoundingClientRect();
        const sidebar = row.closest('.sidebar')?.getBoundingClientRect();
        const margin = 6;
        const left = Math.min(
          (sidebar?.right ?? anchor.right) + margin,
          window.innerWidth - panel.offsetWidth - margin,
        );
        const top = Math.max(
          margin,
          Math.min(
            anchor.top + (anchor.height - panel.offsetHeight) / 2,
            window.innerHeight - panel.offsetHeight - margin,
          ),
        );
        const visible = !clip
          || !(anchor.bottom < clip.top || anchor.top > clip.bottom);
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.visibility = visible ? 'visible' : 'hidden';
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [anchorRef]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCancel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchorRef, onCancel]);

  return createPortal(
    <div
      ref={panelRef}
      className="project-delete-confirmation"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={`delete-project-${project.id}`}
      style={projectColor
        ? { ['--project-delete-accent']: colorToCss(projectColor) } as React.CSSProperties
        : undefined}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span id={`delete-project-${project.id}`} className="project-delete-question">
        Delete project?
      </span>
      <div className="project-delete-actions">
        <button
          ref={noRef}
          type="button"
          className="project-delete-button project-delete-no"
          disabled={deleting}
          onClick={onCancel}
        >
          No
        </button>
        <button
          type="button"
          className="project-delete-button project-delete-yes"
          disabled={deleting}
          onClick={onConfirm}
        >
          {deleting ? <LoaderCircle size={12} className="spin" /> : null}
          Yes
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Sidebar Groups section (B.3).
 *
 * Renders one row per group with:
 *   - Colored dot (click → palette popover → recolor).
 *   - Inline-editable name (click → input, Enter/blur commits).
 *   - Pin button — toggles `frozen` on every member.
 *   - Focus button — sets `groupFocusId` (clicking again clears it).
 *   - Delete button — two-step confirm in place.
 *
 * Empty state instructs the user to create a group from a node's
 * side-panel popover (no top-level "+ Group" action — groups are
 * usually anchored to existing nodes).
 */
function SidebarGroups({
  open,
  onToggle,
  onEnsureOpen,
}: {
  open: boolean;
  onToggle: () => void;
  onEnsureOpen: () => void;
}) {
  // Select the underlying record (stable reference until project.groups
  // is actually mutated), then turn it into an array in render body.
  // Returning Object.values(...) from the selector would mint a fresh
  // array on every store read and infinite-loop the renderer.
  const groupsRecord = useGraphStore((s) => s.project?.groups);
  const groups = useMemo(() => groupsRecord ? Object.values(groupsRecord) : [], [groupsRecord]);
  const groupIds = useMemo(() => groups.map((group) => group.id), [groups]);
  const projectId = useGraphStore((s) => s.project?.id ?? null);
  const lastGroupId = useGraphStore((s) => (
    projectId ? s.lastInteractedGroupIds[projectId] ?? null : null
  ));
  const previewGroup = groups.find((group) => group.id === lastGroupId) ?? groups[0] ?? null;
  const hiddenCount = Math.max(0, groups.length - (previewGroup ? 1 : 0));
  const disclosureDisabled = groups.length <= 1;
  const createGroup = useGraphStore((s) => s.createGroup);
  const reorderGroup = useGraphStore((s) => s.reorderGroup);
  const knownGroupIdsRef = useRef(new Set(groups.map((group) => group.id)));
  const moveGroup = useCallback((fromId: string, toId: string) => {
    reorderGroup(fromId, toId);
  }, [reorderGroup]);

  useEffect(() => {
    if (disclosureDisabled && !open) onEnsureOpen();
  }, [disclosureDisabled, onEnsureOpen, open]);

  useEffect(() => {
    const known = knownGroupIdsRef.current;
    const created = groups.find((group) => !known.has(group.id));
    knownGroupIdsRef.current = new Set(groups.map((group) => group.id));
    if (!created) return;
    onEnsureOpen();
    requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-sidebar-group-id]')]
        .find((candidate) => candidate.dataset.sidebarGroupId === created.id);
      row?.scrollIntoView({ block: 'nearest' });
    });
  }, [groups, onEnsureOpen]);

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title">
        <button
          type="button"
          className="sidebar-section-toggle"
          onClick={() => { if (!disclosureDisabled) onToggle(); }}
          aria-disabled={disclosureDisabled || undefined}
          tabIndex={disclosureDisabled ? -1 : undefined}
          data-tip={disclosureDisabled
            ? groups.length === 0
              ? 'There are no groups to collapse'
              : 'A single group cannot be collapsed'
            : undefined}
          aria-expanded={open}
          aria-controls="sidebar-groups-body"
          aria-label="Groups"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>Groups</span>
        </button>
        <button
          type="button"
          className="sidebar-section-add"
          onClick={() => { createGroup(); }}
          data-tip="Create an empty group"
          aria-label="Create an empty group"
        >
          <Plus size={16} />
        </button>
      </div>
      <SidebarSortableRows
        ids={groupIds}
        disabled={!open}
        onMove={moveGroup}
        scrollContainerId="sidebar-groups-body"
      >
        <div
          id="sidebar-groups-body"
          className={'sidebar-section-body' + (open ? '' : ' sidebar-collapsed-preview')}
        >
          {!open ? (
            previewGroup && (
              <>
                <SidebarGroupRow group={previewGroup} preview />
                <SidebarMoreButton count={hiddenCount} item="group" onClick={onToggle} />
              </>
            )
          ) : groups.length === 0 ? (
            <div
              style={{
                padding: '6px 8px',
                color: 'var(--overlay1)',
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              No groups yet. Click + above, or open a node’s side panel → Group.
            </div>
          ) : (
            groups.map((g) => <SidebarGroupRow key={g.id} group={g} />)
          )}
        </div>
      </SidebarSortableRows>
    </div>
  );
}

export function SidebarGroupRow({ group, preview = false }: { group: Group; preview?: boolean }) {
  const renameGroup = useGraphStore((s) => s.renameGroup);
  const recolorGroup = useGraphStore((s) => s.recolorGroup);
  const deleteGroup = useGraphStore((s) => s.deleteGroup);
  const setGroupFrozen = useGraphStore((s) => s.setGroupFrozen);
  const selectGroup = useGraphStore((s) => s.selectGroup);
  const requestFitNodes = useGraphStore((s) => s.requestFitNodes);
  const touchGroup = useGraphStore((s) => s.touchGroup);
  const selectedGroupId = useGraphStore((s) => s.selectedGroupId);

  // Derive "all members frozen?" — drives the pin/unpin icon state.
  // Walks the nodes record; cheap (typical project ≤ 100 nodes).
  const allFrozen = useGraphStore((s) => {
    if (!s.project) return false;
    const members = Object.values(s.project.nodes).filter(
      (n: ScatterNode) => n.groupId === group.id,
    );
    if (members.length === 0) return false;
    return members.every((n) => n.frozen);
  });

  const { editing, draft, setDraft, inputRef, rowRef, commit, begin, cancel } =
    useRowEdit(group.name, (name) => renameGroup(group.id, name));
  const { setRowRef, sortableProps, sortableStyle, isDragging } = useSortableSidebarRow(
    group.id,
    editing || preview,
    rowRef,
  );

  const selected = selectedGroupId === group.id;

  return (
    <div
      ref={setRowRef}
      data-sidebar-group-id={group.id}
      {...sortableProps}
      className={'sidebar-row has-accent' + (selected ? ' active' : '') + (editing ? ' editing' : '') + (isDragging ? ' sorting' : '')}
      // The group's color tints the whole tab (delicate highlight) via --row-accent.
      style={{
        position: 'relative',
        ...sortableStyle,
        ['--row-accent']: colorToCss(group.color),
      } as React.CSSProperties}
      onClick={() => {
        if (editing) return;
        const members = Object.values(useGraphStore.getState().project?.nodes ?? {})
          .filter((node) => node.groupId === group.id)
          .map((node) => node.id);
        selectGroup(group.id);
        requestFitNodes(members, 'groups');
      }}
      data-tip="Select group"
    >
      {editing ? (
        <input
          ref={inputRef}
          className="row-name row-name-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
        />
      ) : (
        <span className="row-name"><GroupTitleText name={group.name} generation={group.titleGeneration} /></span>
      )}

      <span className="sidebar-row-actions" onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="sidebar-row-action"
          data-tip="Rename & recolor group"
          onClick={(e) => {
            e.stopPropagation();
            touchGroup(group.id);
            // Editing a group opens the floating color panel — drop any
            // focused node so its side/follow-up panels don't compete.
            useGraphStore.getState().setSelection([]);
            begin();
          }}
          style={iconBtnStyle(editing)}
          aria-label={`Edit ${group.name}`}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className="sidebar-row-action"
          data-tip={allFrozen ? 'Unpin all members' : 'Pin all members'}
          onClick={(e) => { e.stopPropagation(); setGroupFrozen(group.id, !allFrozen); }}
          style={iconBtnStyle(allFrozen)}
          aria-label={allFrozen ? `Unpin members of ${group.name}` : `Pin members of ${group.name}`}
        >
          {allFrozen ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button
          type="button"
          className="sidebar-row-action"
          data-tip="Delete group"
          onClick={(e) => {
            e.stopPropagation();
            deleteGroup(group.id);
          }}
          style={iconBtnStyle(false)}
          aria-label={`Delete ${group.name}`}
        >
          <Trash2 size={13} />
        </button>
      </span>

      {/* Color panel — floats under the tab while editing (rename + recolor);
          portaled so the scrolling groups list can't clip it. */}
      {editing && (
        <GroupColorEditor current={group.color} onPick={(c) => recolorGroup(group.id, c)} anchorRef={rowRef} />
      )}
    </div>
  );
}

function SidebarMoreButton({
  count,
  item,
  onClick,
}: {
  count: number;
  item: 'project' | 'group';
  onClick: () => void;
}) {
  if (count < 1) return null;
  const label = `Show ${count} more ${item}${count === 1 ? '' : 's'}`;
  return (
    <button type="button" className="sidebar-more" onClick={onClick} aria-label={label}>
      + {count} more
    </button>
  );
}

function iconBtnStyle(toggled: boolean, danger = false): React.CSSProperties {
  return {
    ['--sidebar-row-action-color']: danger
      ? 'var(--red)'
      : toggled
        ? 'var(--text)'
        : 'var(--overlay1)',
    border: 'none',
    width: 28,
    height: 28,
    flex: '0 0 28px',
    padding: 0,
    cursor: 'var(--cur-click)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 3,
  } as React.CSSProperties;
}

/** useLayoutEffect in the browser, useEffect on the server — measures before
 *  paint on the client without tripping the SSR useLayoutEffect warning. */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Share the sidebar's Projects + Groups lists across the wrapper's height so
 * each scrolls independently: a short list keeps its natural height and donates
 * the rest to the long one; two long lists split the space evenly. The caps are
 * measured here and applied as a `max-height` on each `.sidebar-section-body`
 * (pure CSS can't express this consistently across browsers). Recomputes on
 * wrapper resize (ResizeObserver) and on list content changes (MutationObserver).
 */
function useBalancedListHeights(
  ref: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  projectsOpen: boolean,
  groupsOpen: boolean,
) {
  useIsoLayoutEffect(() => {
    const wrap = ref.current;
    if (!enabled || !wrap) return;

    const recompute = () => {
      const sections = wrap.querySelectorAll<HTMLElement>(':scope > .sidebar-section');
      const secA = sections[0];
      const secB = sections[1];
      if (!secA || !secB) return;
      const bodyA = secA.querySelector<HTMLElement>('.sidebar-section-body');
      const bodyB = secB.querySelector<HTMLElement>('.sidebar-section-body');
      if (!bodyA || !bodyB) return;

      // Clearing maxHeight (below) momentarily removes each body's overflow, and
      // the browser clamps scrollTop to 0 when a body briefly stops overflowing.
      // Capture both scroll positions first and restore them after the caps are
      // re-applied — otherwise a recompute (e.g. the one fired by switching
      // projects, which mutates the Groups list) silently yanks either list back
      // to the top mid-scroll.
      const topA = bodyA.scrollTop;
      const topB = bodyB.scrollTop;

      // Clear prior caps so scrollHeight reports the true content height.
      bodyA.style.maxHeight = '';
      bodyB.style.maxHeight = '';
      const natA = bodyA.scrollHeight;
      const natB = bodyB.scrollHeight;

      // Budget for the two row areas = wrapper height minus the chrome (both
      // titles + section padding = section height minus its uncapped rows).
      const chrome = secA.offsetHeight + secB.offsetHeight - natA - natB;
      const usable = wrap.clientHeight - chrome;

      const { a, b } = splitListHeights(usable, natA, natB);
      // Only cap a list that actually overflows its share — one that fits keeps
      // its natural height (no stray scrollbar, stays compact).
      bodyA.style.maxHeight = a < natA ? `${Math.floor(a)}px` : '';
      bodyB.style.maxHeight = b < natB ? `${Math.floor(b)}px` : '';
      // Restore the scroll positions the maxHeight clear reset to 0.
      bodyA.scrollTop = topA;
      bodyB.scrollTop = topB;
    };

    // Coalesce bursts of observer callbacks into one measure per frame.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; recompute(); });
    };

    recompute();
    const ro = new ResizeObserver(schedule);
    ro.observe(wrap);
    // childList/characterData only (NOT attributes) — so our own maxHeight
    // writes don't re-trigger the observer.
    const mo = new MutationObserver(schedule);
    mo.observe(wrap, { childList: true, subtree: true, characterData: true });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref, enabled, projectsOpen, groupsOpen]);
}
