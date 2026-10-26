'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpenText, ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { activeProjectSources, orderedSources, sourceLibrary } from '@/lib/projectSources';
import type { ProjectSourceMode } from '@/store/types';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';

export function SourceControls({
  disabled = false,
  showManagerButton = true,
  inert = false,
  emptyAction = 'import',
  virtualEmpty = false,
}: {
  disabled?: boolean;
  showManagerButton?: boolean;
  /** Paint-only restoration-shell variant: same geometry, no focusable controls. */
  inert?: boolean;
  /** Empty topic-picker projects reveal their embedded manager first. */
  emptyAction?: 'import' | 'manager';
  /** The new-project picker is still overlaying the previous project. Present
   * an empty source state until the first source is actually committed. */
  virtualEmpty?: boolean;
}) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const project = useGraphStore((state) => state.project);
  const jobs = useSourceRuntimeStore((state) => state.jobs);
  const setMode = useGraphStore((state) => state.setSourceMode);
  const library = sourceLibrary(virtualEmpty ? null : project);
  const pending = virtualEmpty ? [] : Object.values(jobs).filter((job) => (
    job.projectId === project?.id && job.status !== 'failed'
  ));
  const total = orderedSources(library).length + pending.length;
  const active = activeProjectSources(library).length
    + pending.filter((job) => job.checkedOnSuccess).length;
  const noSources = total === 0;
  const effectiveMode = active === 0 ? 'ignore' : library.mode;
  const managerOpen = useSourceUiStore((state) => state.managerOpen);
  const toggleManager = useSourceUiStore((state) => state.toggleManager);
  const openImport = useSourceUiStore((state) => state.openImport);

  useEffect(() => {
    if (!modeMenuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!modeMenuRef.current?.contains(event.target as Node)) setModeMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModeMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [modeMenuOpen]);

  const choose = (mode: ProjectSourceMode) => {
    if (!project || noSources || disabled) return;
    setMode(mode);
    setModeMenuOpen(false);
  };

  const modeLabel = effectiveMode === 'ignore'
    ? 'Ignore sources'
    : effectiveMode === 'use'
      ? 'Use sources'
      : 'Limit to sources';

  return (
    <div className="source-controls" aria-label="Project sources">
      <div className="source-mode-dropdown" ref={modeMenuRef}>
        {inert ? (
          <span className="source-mode-trigger">
            <span>{modeLabel}</span>
            <ChevronUp size={14} aria-hidden="true" />
          </span>
        ) : (
          <button
            type="button"
            className="source-mode-trigger"
            disabled={disabled || noSources}
            onClick={() => setModeMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={modeMenuOpen}
            data-tip={noSources
              ? 'Add sources before choosing how to use them'
              : 'Choose how Scatter uses active project sources'}
          >
            <span>{modeLabel}</span>
            {modeMenuOpen
              ? <ChevronDown size={14} aria-hidden="true" />
              : <ChevronUp size={14} aria-hidden="true" />}
          </button>
        )}
        {!inert && modeMenuOpen && (
          <div className="source-mode-menu" role="menu" aria-label="How Scatter uses active sources">
            {([
              ['ignore', 'Ignore sources', 'Do not use project sources for future generation'],
              ['use', 'Use sources', 'Use sources while allowing outside knowledge'],
              ['only', 'Limit to sources', 'Write only from active project sources'],
            ] as const).map(([mode, label, tip]) => (
              <button
                key={mode}
                type="button"
                className={effectiveMode === mode ? 'active' : ''}
                role="menuitemradio"
                aria-checked={effectiveMode === mode}
                onClick={() => choose(mode)}
                data-tip={tip}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {showManagerButton && <>
        <span className="source-controls-divider" aria-hidden="true" />
        {inert ? (
          <span className="source-manager-button">
            <Plus size={14} />
            <span>Add sources</span>
          </span>
        ) : (
          <button
            type="button"
            className="source-manager-button"
            disabled={disabled}
            data-source-manager-trigger
            aria-expanded={!noSources || emptyAction === 'manager' ? managerOpen : undefined}
            onClick={() => {
              if (!noSources || emptyAction === 'manager') toggleManager();
              else openImport();
            }}
            data-tip={noSources ? 'Add files, webpages, or pasted text' : 'Choose and manage project sources'}
          >
            {noSources ? <Plus size={14} /> : <BookOpenText size={14} />}
            <span>{noSources ? 'Add sources' : `Sources ${active}/${total}`}</span>
          </button>
        )}
      </>}
    </div>
  );
}
