'use client';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { watchFocusedTermPreviews } from '@/lib/termPreviews';
import dynamic from 'next/dynamic';
import { PanelLeftOpen } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { matchAction } from '@/lib/keymap';
import {
  activateReadingReference,
  exitReading,
  handleReadingArrow,
  readingActive,
  SOURCE_VIEWER_READING_ID,
} from '@/lib/readingController';
import { zoomCameraBy, ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR } from '@/lib/zoomCamera';
import { hasConnectedProvider } from '@/store/providerSelectors';
import { useProjectPersistence } from '@/store/persist';
import { Sidebar } from '@/components/Sidebar';
import { ProjectRestorationScreen } from '@/components/ProjectRestorationScreen';
import { redoGraphHistory, undoGraphHistory } from '@/lib/graphHistoryActions';
import { SettingsModal } from '@/components/SettingsModal';
import type { SettingsPageId } from '@/components/settings/settingsNavigation';
import { PixelRuler } from '@/components/dev/PixelRuler';
import { DeviceWarning } from '@/components/DeviceWarning';
import { ProjectFavicon } from '@/components/ProjectFavicon';
import { Canvas } from '@/components/canvas/Canvas';
import { WelcomeScreenA } from '@/components/welcome/WelcomeScreenA';
import { WelcomeScreenB } from '@/components/welcome/WelcomeScreenB';
import {
  generateRoot, spawnFollowUp, modifyNode,
} from '@/lib/generate';
import { useClickFlash } from '@/lib/clickFlash';
import { useFullscreenSidebar } from '@/lib/useFullscreenSidebar';
import { useSidebarAutoPeek } from '@/lib/useSidebarAutoPeek';
import { activateReference } from '@/lib/referenceAction';
import {
  resolveStartupSurfaces,
  shouldHoldRestorationForProject,
} from '@/lib/startupSurfaces';
import { colorToCss } from '@/lib/groupColor';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';
import { useEditorStore } from '@/store/useEditorStore';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { useChatTableStore } from '@/store/useChatTableStore';
import { initializeSyncCoordinator } from '@/sync/coordinator';
import { SyncRemoteUpdateModal } from '@/components/SyncRemoteUpdateModal';
import { GoogleDriveReconnectModal } from '@/components/GoogleDriveReconnectModal';
import { SecondaryModelCatalogCoordinator } from '@/components/SecondaryModelCatalogCoordinator';
import { RecommendedModelsCoordinator } from '@/components/RecommendedModelsCoordinator';
import { SourceManager } from '@/components/sources/SourceManager';
import { SourceImportOverlay } from '@/components/sources/SourceImportOverlay';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { prepareSourceEmbeddingModel } from '@/lib/sourceProcessing';

// Lazy: keeps TipTap out of the first load — it arrives only when the editor opens.
const TextEditorOverlay = dynamic(() => import('@/components/editor/TextEditorOverlay'), {
  ssr: false,
});
const ChatTableViewer = dynamic(() => import('@/components/chat/ChatTableViewer'), { ssr: false });
const ScreenshotTool = dynamic(() => import('@/components/dev/ScreenshotTool'), { ssr: false });
// Lazy: keeps Konva out of the first load — it arrives only when the image editor opens.
const ImageEditorOverlay = dynamic(() => import('@/components/imageEditor/ImageEditorOverlay'), {
  ssr: false,
});
const InteractiveViewerOverlay = dynamic(
  () => import('@/components/interactiveViewer/InteractiveViewerOverlay'),
  { ssr: false },
);
const WikimediaGalleryOverlay = dynamic(
  () => import('@/components/wikimedia/WikimediaGalleryOverlay'),
  { ssr: false },
);
const SourceViewerOverlay = dynamic(
  () => import('@/components/sources/SourceViewerOverlay'),
  { ssr: false },
);

export default function Page() {
  useEffect(watchFocusedTermPreviews, []);
  const projectBootstrap = useProjectPersistence();
  const [startupCanvasReady, setStartupCanvasReady] = useState(false);
  const [minimumRestorationCycleComplete, setMinimumRestorationCycleComplete] = useState(false);
  const completeMinimumRestorationCycle = useCallback(() => {
    setMinimumRestorationCycleComplete(true);
  }, []);
  // Brief mouse-pointer-click flash on press of any clickable (app-wide).
  useClickFlash();
  const project = useGraphStore((s) => s.project);
  const pickerOpen = useGraphStore((s) => s.pickerOpen);
  // Remounts the Canvas on scatter switch so its mount effects reseed live
  // positions + camera from the newly active project (see projectActions.ts).
  const activeProjectId = useGraphStore((s) => s.activeProjectId);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const providers = useSettingsStore((s) => s.providers);
  const activeModelRef = useSettingsStore((s) => s.activeModelRef);
  const forceWelcomeA = useSettingsStore((s) => s.forceWelcomeA);

  const [settingsOrigin, setSettingsOrigin] = useState<'canvas' | 'picker' | null>(null);
  const [settingsPage, setSettingsPage] = useState<SettingsPageId | undefined>();
  const settingsOpen = settingsOrigin !== null;
  // `sidebarCollapsed` is the persistent intent; `peeking` is a transient
  // hover reveal while collapsed. The panel is shown (full overlay) when not
  // collapsed OR while peeking; it's slid off-screen only when collapsed and
  // not peeking.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [sidebarPeekLocked, setSidebarPeekLocked] = useState(false);
  const interactiveViewerOpen = useInteractiveViewerStore((state) => state.open);
  const textEditorOpen = useEditorStore((state) => state.open);
  const imageEditorOpen = useImageEditorStore((state) => state.open);
  const sourceViewerOpen = useSourceUiStore((state) => state.viewer !== null);
  const tableViewerOpen = useChatTableStore((state) => state.target !== null);
  const sourceManagerOpen = useSourceUiStore((state) => state.managerOpen);
  const fullWindowSurfaceOpen = interactiveViewerOpen || textEditorOpen || imageEditorOpen || sourceViewerOpen || tableViewerOpen;
  // Full-window viewers temporarily suppress the sidebar without changing the
  // user's persistent collapse preference. Closing the viewer restores exactly
  // the sidebar state they had before opening it.
  const effectiveSidebarCollapsed = sidebarCollapsed || fullWindowSurfaceOpen;
  useEffect(() => {
    if (fullWindowSurfaceOpen) setPeeking(false);
  }, [fullWindowSurfaceOpen]);
  useFullscreenSidebar({
    collapsed: sidebarCollapsed,
    setCollapsed: setSidebarCollapsed,
    closePeek: () => setPeeking(false),
  });
  useSidebarAutoPeek({
    collapsed: effectiveSidebarCollapsed,
    setPeeking,
    disabled: fullWindowSurfaceOpen,
    locked: sidebarPeekLocked,
  });

  useEffect(() => { void hydrate(); }, [hydrate]);

  const sourceCount = project?.sourceLibrary
    ? Object.keys(project.sourceLibrary.sources).length
    : 0;
  useEffect(() => {
    // Warm it whenever the manager explains its state, and whenever a restored
    // or synced project already owns sources—even if the user generates before
    // opening the manager on this device.
    if (sourceManagerOpen || sourceCount > 0) void prepareSourceEmbeddingModel();
  }, [sourceCount, sourceManagerOpen]);

  // Cloud sync starts only after both local projects and settings have
  // finished restoring. The rotating-orb shell therefore never performs
  // network work or advertises a project as synchronized prematurely.
  useEffect(() => {
    if (!hydrated || projectBootstrap.status !== 'ready') return;
    void initializeSyncCoordinator().catch((error) => {
      console.error('[scatter] synchronization could not initialize', error);
    });
  }, [hydrated, projectBootstrap.status]);

  // NOTE: the active scatter is now created/loaded by bootstrapScatters()
  // inside useProjectPersistence() — no separate "ensure a project exists"
  // effect needed (it would mint an unregistered project with no index row).

  useEffect(() => {
    // ── Keyboard camera panning (WASD — arrows belong to the reading
    // ruler now, see the Arrow branch below) ──────────────────────────
    // Camera moves TOWARD the key: pressing D travels the view right,
    // so content shifts left (viewport.x decreases). The signs below add to
    // the viewport offset to produce that. We pan the LIVE viewport store
    // every frame (smooth, no React work) and commit once to the project store
    // on release for autosave. Semantic undo deliberately ignores camera moves.
    const PAN_KEYS: Record<string, [number, number]> = {
      w: [0, 1],
      s: [0, -1],
      a: [1, 0],
      d: [-1, 0],
    };
    const PAN_STEP = 4.5; // screen px/frame — 50% faster; diagonals stay normalized
    const held = new Set<string>();
    let panRaf: number | null = null;

    const panLoop = () => {
      let ax = 0, ay = 0;
      for (const k of held) { const v = PAN_KEYS[k]; if (v) { ax += v[0]; ay += v[1]; } }
      let dx = Math.sign(ax), dy = Math.sign(ay);
      if (dx === 0 && dy === 0) { panRaf = null; return; }
      if (dx !== 0 && dy !== 0) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
      const lv = useLiveViewportStore.getState();
      lv.setPan(lv.x + dx * PAN_STEP, lv.y + dy * PAN_STEP);
      panRaf = requestAnimationFrame(panLoop);
    };
    const commitPan = () => {
      const lv = useLiveViewportStore.getState();
      useGraphStore.getState().setViewport({ x: lv.x, y: lv.y, zoom: lv.zoom });
    };
    const stopPan = () => {
      if (panRaf !== null) { cancelAnimationFrame(panRaf); panRaf = null; }
      commitPan();
    };

    const handler = (e: KeyboardEvent) => {
      // Settings owns its keys, including selects and buttons after typing.
      // Never pan, undo the project, or toggle the sidebar behind the dialog.
      if (e.defaultPrevented || e.isComposing || document.querySelector('.settings-modal')) return;
      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' ||
        target.isContentEditable
      );
      // User overrides for rebindable shortcuts (read fresh each keypress so
      // a rebind takes effect without re-registering this listener).
      const ov = useSettingsStore.getState().keybindings;
      const viewerOpen = useInteractiveViewerStore.getState().open;
      const sourceViewer = useSourceUiStore.getState().viewer;
      const tableViewer = useChatTableStore.getState().target;
      // With no focused element, keyboard actions still belong to the canvas.
      // Initial-root following yields to any such action, not only WASD/Q/E.
      if ((target === document.body || target === document.documentElement)
        && !viewerOpen && !sourceViewer && !tableViewer
        && !useEditorStore.getState().open && !useImageEditorStore.getState().open
        && !document.querySelector('[role="dialog"]')
        && useGraphStore.getState().panTo?.automatic === 'rootGeneration') {
        commitPan();
        useGraphStore.getState().requestPanTo(null);
      }

      // Search — works even while an input is focused (the user is asking to
      // jump to search). Reveals the sidebar if collapsed, then focuses.
      if (matchAction(e, 'search', ov)) {
        e.preventDefault();
        if (
          viewerOpen
          || !!tableViewer
          || !!sourceViewer
          || useEditorStore.getState().open
          || useImageEditorStore.getState().open
        ) return;
        const search = document.querySelector('.search-input') as HTMLElement | null;
        if (search) { search.focus(); return; }
        setSidebarCollapsed(false);
        setPeeking(false);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            (document.querySelector('.search-input') as HTMLElement | null)?.focus();
          }),
        );
        return;
      }
      // Toggle sidebar — also works while typing (no editor binds ⌘B).
      if (matchAction(e, 'toggleSidebar', ov)) {
        e.preventDefault();
        if (
          viewerOpen
          || !!tableViewer
          || !!sourceViewer
          || useEditorStore.getState().open
          || useImageEditorStore.getState().open
        ) return;
        setSidebarCollapsed((c) => !c);
        setPeeking(false);
        return;
      }
      // Escape (fixed): inside a text input, blur; on canvas, deselect. Skip
      // if a modal is open — its own Esc handler closes it.
      if (e.key === 'Escape') {
        if (document.querySelector('[role="dialog"]')) return;
        if (inEditable) {
          target!.blur();
          return;
        }
        // Reading ruler first: Esc turns the highlight off and is CONSUMED —
        // the node stays selected (the next Esc deselects as usual).
        if (readingActive()) {
          exitReading();
          return;
        }
        const proj = useGraphStore.getState().project;
        if (proj && proj.selection.length > 0) {
          useGraphStore.getState().setSelection([]);
        }
        return;
      }
      if (inEditable) return;

      // In word mode, Enter activates the reference represented by the current
      // reading cluster. It reuses the exact click path, including the
      // Ctrl/⌘ "spawn collapsed" behavior.
      if (
        e.key === 'Enter'
        && !e.altKey
        && !e.shiftKey
        && activateReadingReference(e.ctrlKey || e.metaKey)
      ) {
        e.preventDefault();
        return;
      }

      // The interactive viewer owns the foreground. Keep its reading-ruler
      // arrows, but never let Q/E, WASD, model cycling, or undo mutate the
      // canvas hidden behind the modal.
      if (viewerOpen || sourceViewer || tableViewer) {
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.startsWith('Arrow')) {
          const proj = useGraphStore.getState().project;
          const only = sourceViewer?.nodeId
            ?? tableViewer?.nodeId
            ?? (sourceViewer ? SOURCE_VIEWER_READING_ID : undefined)
            ?? (proj?.selection.length === 1 ? proj.selection[0] : undefined);
          if (only) {
            e.preventDefault();
            handleReadingArrow(e.key, only);
          }
        }
        return;
      }

      // Fullscreen toggle. Stateless DOM API (same as the nav button).
      if (matchAction(e, 'fullscreen', ov)) {
        e.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.();
        return;
      }

      // Keyboard zoom — E in, Q out. Smooth + centred on the visible canvas
      // (shared with the nav buttons). No-modifier only, so ⌘Q stays the
      // browser's.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'q' || e.key === 'e')) {
        e.preventDefault();
        zoomCameraBy(e.key === 'e' ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR);
        return;
      }

      // Reading ruler — bare arrows with exactly one node selected step the
      // line/word highlight (lib/readingController). Arrows never pan: with
      // no (or a multi-) selection they intentionally do nothing.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.startsWith('Arrow')) {
        const proj = useGraphStore.getState().project;
        const only = proj?.selection.length === 1 ? proj.selection[0] : undefined;
        if (only) {
          e.preventDefault();
          handleReadingArrow(e.key, only);
        }
        return;
      }

      // Camera panning — WASD (fixed; see PAN_KEYS above).
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const dir = PAN_KEYS[e.key.toLowerCase()];
        if (dir) {
          e.preventDefault();
          // Starting a fresh gesture: cancel any in-flight follow tween so the
          // keyboard pan doesn't fight the camera.
          if (held.size === 0) useGraphStore.getState().requestPanTo(null);
          held.add(e.key.toLowerCase());
          if (panRaf === null) panRaf = requestAnimationFrame(panLoop);
          return;
        }
      }

      // Undo / redo / switch-model (rebindable).
      if (matchAction(e, 'undo', ov)) {
        e.preventDefault();
        undoGraphHistory();
        return;
      }
      if (matchAction(e, 'redo', ov)) {
        e.preventDefault();
        redoGraphHistory();
        return;
      }
      if (matchAction(e, 'cycleModel', ov)) {
        // Shift = previous (the binding ignores shift; we read it here).
        e.preventDefault();
        useSettingsStore.getState().cycleModel(e.shiftKey ? -1 : 1);
        return;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (held.delete(e.key.toLowerCase()) && held.size === 0) stopPan();
    };
    // Losing window focus (alt-tab, devtools) can swallow keyup — clear held
    // keys and commit so the camera doesn't keep drifting.
    const onBlur = () => { if (held.size > 0) { held.clear(); stopPan(); } };
    window.addEventListener('keydown', handler);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (panRaf !== null) cancelAnimationFrame(panRaf);
    };
  }, []);

  // Routing logic. Settings hydration and the OPFS project read finish
  // independently; until BOTH are resolved we show the restoration shell so an
  // unknown project cannot masquerade as an empty one. Once ready, Welcome B is
  // an overlay when explicitly opened or when the confirmed project is empty.
  // Canvas remains mounted behind that overlay whenever a project exists.
  const {
    showRestoration,
    showRestorationError,
    showWelcomeA,
    showWelcomeB,
    showCanvas,
  } = resolveStartupSurfaces({
    settingsHydrated: hydrated,
    projectBootstrapStatus: projectBootstrap.status,
    forceWelcomeA,
    providerConnected: hasConnectedProvider({ providers }),
    hasActiveModel: Boolean(activeModelRef),
    pickerOpen,
    hasProject: project != null,
    projectHasNodes: Boolean(project && Object.keys(project.nodes).length > 0),
    editingPickerSettings: settingsOrigin === 'picker',
  });
  const holdRestorationForProject = shouldHoldRestorationForProject({
    showCanvas,
    startupCanvasReady,
    minimumCycleComplete: minimumRestorationCycleComplete,
  });

  const appAccentStyle = project?.color
    ? { '--control-accent': colorToCss(project.color) } as CSSProperties
    : undefined;

  return (
    <main className="relative flex flex-row h-full overflow-hidden" style={appAccentStyle}>
      <ProjectFavicon />
      {(showRestoration || showRestorationError || holdRestorationForProject) && (
        <ProjectRestorationScreen
          error={showRestorationError ? projectBootstrap.error : null}
          onMinimumCycleComplete={completeMinimumRestorationCycle}
        />
      )}
      {showCanvas && (
        <Sidebar
          collapsed={effectiveSidebarCollapsed}
          peeking={fullWindowSurfaceOpen ? false : peeking}
          onToggle={() => { setSidebarCollapsed((c) => !c); setPeeking(false); }}
          onOpenSettings={(page) => { setSettingsPage(page); setSettingsOrigin('canvas'); }}
          onPeekLockChange={setSidebarPeekLocked}
        />
      )}

      {/* Floating reveal button — the only sidebar affordance while it's
          slid away. A left-edge hover peek (see effect above) is the other. */}
      {showCanvas && effectiveSidebarCollapsed && !fullWindowSurfaceOpen && (
        <button
          type="button"
          className="sidebar-reveal-btn"
          onClick={() => { setSidebarCollapsed(false); setPeeking(false); }}
          data-tip="Show sidebar (Ctrl/⌘+B)"
          aria-label="Show sidebar"
        >
          <PanelLeftOpen size={20} />
        </button>
      )}

      <div className="flex-1 relative overflow-hidden">
        {showCanvas && (
          <Canvas
            key={activeProjectId}
            progressiveStartup={!startupCanvasReady}
            onStartupReady={() => setStartupCanvasReady(true)}
            suppressAuraLayer={holdRestorationForProject}
            sidebarCollapsed={effectiveSidebarCollapsed}
            sidebarPeeking={fullWindowSurfaceOpen ? false : peeking}
            onOpenSettings={() => setSettingsOrigin('canvas')}
            onReferenceClick={(parentId, term, opts) => {
              console.log('[scatter] reference clicked:', term, 'parent:', parentId);
              activateReference(parentId, term, opts);
            }}
            onAskFollowUp={(parentId, q) => { void spawnFollowUp(parentId, q); }}
            onModify={(id, instr) => { void modifyNode(id, instr); }}
          />
        )}
        {showCanvas && <TextEditorOverlay />}
        {showCanvas && <ChatTableViewer />}
        {showCanvas && <ImageEditorOverlay />}
        {showCanvas && <InteractiveViewerOverlay />}
        {showCanvas && <WikimediaGalleryOverlay />}
        <SourceViewerOverlay />
      </div>

      {showWelcomeA && <WelcomeScreenA />}
      {showWelcomeB && !holdRestorationForProject && <WelcomeScreenB onOpenSettings={() => setSettingsOrigin('picker')} settingsOpen={settingsOpen} />}

      {sourceManagerOpen && !showWelcomeB && (
        <SourceManager
          anchor={effectiveSidebarCollapsed ? 'floating' : 'sidebar'}
          onInteractionLockChange={setSidebarPeekLocked}
        />
      )}
      <SourceImportOverlay />

      <SettingsModal
        open={settingsOpen}
        initialPage={settingsPage}
        onClose={() => { setSettingsOrigin(null); setSettingsPage(undefined); }}
      />
      <SecondaryModelCatalogCoordinator />
      <RecommendedModelsCoordinator />
      <SyncRemoteUpdateModal />
      <GoogleDriveReconnectModal />

      {/* Dev pixel-measuring overlay (viewport variant — fixed to the
          browser viewport, does NOT scale with canvas zoom). The
          canvas-tracked variant is mounted inside Canvas.tsx. Both
          read the same store flag and only the matching one renders. */}
      <PixelRuler attachment="viewport" />
      <ScreenshotTool />

      {/* Steers usage toward desktop + landscape; blurs the app behind it. */}
      <DeviceWarning />

      {/* Heads-up when a shipped default prompt changed since the user customized it. */}
    </main>
  );
}
