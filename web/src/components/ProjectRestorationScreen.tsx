'use client';
import { languageInfo } from '@/lib/languages';

import {
  ChevronsUpDown,
  ChevronDown,
  CloudSync,
  Globe,
  Maximize2,
  Moon,
  PanelLeftClose,
  Plus,
  Redo2,
  Search,
  Settings,
  Sun,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AsciiAuraLayer } from './canvas/AsciiAuraLayer';
import { SidebarWordmark } from './SidebarWordmark';
import { SourceControls } from './sources/SourceControls';
import { OfflineIndicator } from './OfflineIndicator';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useSyncStore } from '@/store/useSyncStore';
import { hasSyncConnection } from '@/sync/connection';
import { modelDisplayName } from '@/lib/modelDisplay';
import { effectiveReasoningEffort } from '@/lib/modelReasoning';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { ReasoningGauge } from './ReasoningGauge';
import type { GroupColorAssignment } from '@/store/types';
import type { AuraSceneFactory } from '@/lib/asciiAura/sceneState';
import {
  RESTORATION_ORBIT_PERIOD_MS,
  RESTORATION_RECOLOR_MS,
  createRestorationAuraController,
  generateRestorationColorPair,
  restorationOrbitPoints,
  type RestorationAuraController,
  type RestorationColorPair,
} from '@/lib/restorationVisuals';

interface ProjectRestorationScreenProps {
  error?: Error | null;
  onMinimumCycleComplete?: () => void;
}

interface CanvasSize {
  width: number;
  height: number;
}

/** Select client-random colors before this shell's first visible paint. */
export function ProjectRestorationScreen({
  error = null,
  onMinimumCycleComplete,
}: ProjectRestorationScreenProps) {
  const colorAssignment = useSettingsStore((state) => state.groupColorAssignment);
  const [initial, setInitial] = useState<{
    assignment: GroupColorAssignment;
    colors: RestorationColorPair;
  } | null>(null);

  useLayoutEffect(() => {
    setInitial({
      assignment: colorAssignment,
      colors: generateRestorationColorPair(colorAssignment),
    });
  }, [colorAssignment]);

  if (!initial || initial.assignment !== colorAssignment) return null;
  return (
    <ActiveRestorationScreen
      key={colorAssignment}
      initialColors={initial.colors}
      colorAssignment={colorAssignment}
      error={error}
      onMinimumCycleComplete={onMinimumCycleComplete}
    />
  );
}

function ActiveRestorationScreen({
  initialColors,
  colorAssignment,
  error,
  onMinimumCycleComplete,
}: {
  initialColors: RestorationColorPair;
  colorAssignment: GroupColorAssignment;
  error: Error | null;
  onMinimumCycleComplete?: () => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<RestorationAuraController | null>(null);
  const orbitStartedAtRef = useRef<number | null>(null);
  const [colors, setColors] = useState(initialColors);
  const [colorEpoch, setColorEpoch] = useState(0);
  const [size, setSize] = useState<CanvasSize | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(
      () => onMinimumCycleComplete?.(),
      RESTORATION_ORBIT_PERIOD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [onMinimumCycleComplete]);

  useLayoutEffect(() => {
    if (orbitStartedAtRef.current === null) {
      orbitStartedAtRef.current = performance.now();
    }
    const container = canvasRef.current;
    if (!container) return;
    const readSize = () => setSize({
      width: container.clientWidth,
      height: container.clientHeight,
    });
    readSize();
    const observer = new ResizeObserver(readSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  const initialPoints = useMemo(() => restorationOrbitPoints({
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    elapsedMs: 0,
    reducedMotion,
  }), [reducedMotion, size]);

  const sceneFactory = useCallback<AuraSceneFactory>(({ onDirty }) => {
    const controller = createRestorationAuraController({
      colors,
      points: initialPoints,
      now: performance.now(),
      onDirty,
    });
    controllerRef.current = controller;
    return controller.scene;
    // The factory is consumed once when the renderer mounts. Later colors and
    // positions flow through controllerRef without replacing the GL scene.
  }, [colors, initialPoints]);

  useEffect(() => {
    if (!size) return;
    const startedAt = orbitStartedAtRef.current ?? performance.now();
    let frame: number | null = null;
    const paintPosition = (now: number) => {
      controllerRef.current?.setPositions(restorationOrbitPoints({
        width: size.width,
        height: size.height,
        elapsedMs: now - startedAt,
        reducedMotion: reducedMotion || Boolean(error),
      }));
      if (!reducedMotion && !error) frame = requestAnimationFrame(paintPosition);
    };
    paintPosition(startedAt);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [error, reducedMotion, size]);

  useEffect(() => {
    if (error) return;
    const startedAt = orbitStartedAtRef.current ?? performance.now();
    let timer: number | null = null;
    let cancelled = false;
    const updateColors = () => {
      const next = generateRestorationColorPair(colorAssignment);
      setColors(next);
      setColorEpoch((epoch) => epoch + 1);
      controllerRef.current?.setColors(next, performance.now());
    };
    const scheduleNextCrossing = () => {
      if (cancelled) return;
      const now = performance.now();
      const elapsed = Math.max(0, now - startedAt);
      const nextCrossing = startedAt
        + (Math.floor(elapsed / RESTORATION_RECOLOR_MS) + 1) * RESTORATION_RECOLOR_MS;
      timer = window.setTimeout(() => {
        updateColors();
        scheduleNextCrossing();
      }, Math.max(0, nextCrossing - now));
    };
    scheduleNextCrossing();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [colorAssignment, error]);

  useEffect(() => () => { controllerRef.current = null; }, []);

  const palette = useMemo(() => [colors.project, colors.group], [colors]);

  return (
    <div
      className="project-restoration"
      aria-busy={error ? undefined : true}
      aria-label={error ? 'Project restoration failed' : 'Restoring project'}
    >
      <RestorationSidebar colors={colors} palette={palette} colorEpoch={colorEpoch} />
      <div ref={canvasRef} className="project-restoration-canvas">
        {size && (
          <AsciiAuraLayer
            containerRef={canvasRef}
            sceneFactory={sceneFactory}
            renderAppOverlays={false}
          />
        )}
        {error && (
          <div className="project-restoration-message" role="status" aria-live="polite">
            <span>COULDN&apos;T RESTORE PROJECTS</span>
            <button type="button" onClick={() => window.location.reload()}>Reload</button>
          </div>
        )}
      </div>
    </div>
  );
}

function RestorationSidebar({
  colors,
  palette,
  colorEpoch,
}: {
  colors: RestorationColorPair;
  palette: readonly string[];
  colorEpoch: number;
}) {
  const theme = useResolvedTheme();
  const modelRef = useSettingsStore((state) => state.activeModelRef);
  const activeModel = modelRef?.model;
  const provider = useSettingsStore((state) => state.providers.find((account) => account.id === modelRef?.providerId));
  const requestedEffort = useSettingsStore((state) => state.reasoningEffort);
  const modelInfo = useModelCatalogStore((state) => modelRef
    ? state.catalog[modelRef.providerId]?.find((model) => model.id === modelRef.model) : undefined);
  const effort = provider && modelRef
    ? effectiveReasoningEffort(provider.preset, modelRef.model, requestedEffort, modelInfo) : undefined;
  const webSearch = useSettingsStore((state) => state.webSearch);
  const language = useSettingsStore((state) => state.generationLanguage);
  const ThemeIcon = theme === 'dark' ? Moon : Sun;
  const footerIcons = [Undo2, Redo2, ZoomIn, ZoomOut, Maximize2, ThemeIcon, Settings];

  return (
    <aside className="sidebar project-restoration-sidebar" aria-hidden="true">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <SidebarWordmark paletteOverride={palette} reshuffleToken={colorEpoch} />
          <OfflineIndicator />
        </div>
        <span className="sidebar-toggle project-restoration-control"><PanelLeftClose size={20} /></span>
      </div>

      <div className="search-wrap project-restoration-search">
        <span className="search-icon"><Search size={13} /></span>
        <span className="project-restoration-search-bar" />
      </div>

      <div className="sidebar-lists project-restoration-lists">
        <RestorationSection title="Projects" color={colors.project} />
        <RestorationSection title="Groups" color={colors.group} />
      </div>

      <div className="sidebar-control-panel project-restoration-control-panel">
        <div className="sc-modelpicker sc-modelpicker--toolbar project-restoration-modelpicker">
          <div className="sc-modelpicker-row">
            <span className="sc-modelpicker-btn project-restoration-control">
              <span className="sc-modelpicker-label">{activeModel ? modelDisplayName(activeModel) : 'Pick a model'}</span>
              <ChevronsUpDown viewBox="6 0 12 24" width={8} height={16} />
            </span>
            <span className="sc-modelpicker-websearch sc-language-trigger project-restoration-control">
              <span className="sc-language-trigger-label">{languageInfo(language).code}</span>
            </span>
            <span className="sc-modelpicker-websearch project-restoration-control"><ReasoningGauge effort={effort} /></span>
            <span
              className={
                'sc-modelpicker-websearch project-restoration-control'
                + (webSearch ? ' active' : '')
              }
            >
              <Globe size={16} />
            </span>
          </div>
        </div>
        <SourceControls disabled inert />
        <div className="sidebar-footer project-restoration-footer">
          {footerIcons.map((Icon, index) => (
            <span key={index} className="icon-btn project-restoration-control">
              <Icon size={16} />
            </span>
          ))}
        </div>
      </div>
    </aside>
  );
}

function RestorationSection({ title, color }: { title: string; color: string }) {
  const syncConnected = useSyncStore(state => hasSyncConnection(state.config));
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title">
        <span className="sidebar-section-toggle">
          <ChevronDown size={14} />
          <span>{title}</span>
        </span>
        <span className="sidebar-section-actions">
          {title === 'Projects' && <span className={'sidebar-section-add sidebar-sync-button' + (syncConnected ? '' : ' failed')}><CloudSync size={16} /></span>}
          <span className="sidebar-section-add"><Plus size={16} /></span>
        </span>
      </div>
      <div className="sidebar-section-body">
        <div
          className="sidebar-row has-accent project-restoration-row"
          style={{ '--row-accent': color } as React.CSSProperties}
        >
          <span className="project-restoration-row-bar" />
        </div>
      </div>
    </div>
  );
}
