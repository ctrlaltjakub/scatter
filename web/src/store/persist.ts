import { useEffect, useState } from 'react';
import { useGraphStore } from './useGraphStore';
import { useActiveIdxStore } from './useActiveIdxStore';
import { bootstrapScatters } from './projectActions';
import {
  flushProjectPersistence,
  scheduleProjectAutosave,
  scheduleReadingPositionAutosave,
} from './projectPersistence';

export type ProjectBootstrapStatus = 'pending' | 'ready' | 'error';

export interface ProjectBootstrapState {
  status: ProjectBootstrapStatus;
  error: Error | null;
}

// React Strict Mode mounts effects twice in development. Share the in-flight
// bootstrap so those two passes cannot race while reading/migrating OPFS.
let bootstrapPromise: Promise<void> | null = null;

function bootstrapOnce(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapScatters().catch((error) => {
      // A later page reload/remount may retry a failed read.
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

export function useProjectPersistence(): ProjectBootstrapState {
  const [bootstrap, setBootstrap] = useState<ProjectBootstrapState>({
    status: 'pending',
    error: null,
  });

  // Hydrate on mount: load the scatter registry (migrating the legacy
  // single-project file if present), then load the active scatter into the
  // graph store. See bootstrapScatters in projectActions.ts.
  useEffect(() => {
    let active = true;
    void bootstrapOnce().then(
      () => {
        if (active) setBootstrap({ status: 'ready', error: null });
      },
      (error: unknown) => {
        if (!active) return;
        const normalized = error instanceof Error ? error : new Error(String(error));
        console.error('[scatter] project restoration failed:', normalized);
        setBootstrap({ status: 'error', error: normalized });
      },
    );
    return () => { active = false; };
  }, []);

  // Only project-reference changes schedule autosave. Runtime-only graph
  // events (search, highlights, camera requests, group hover memory) used to
  // keep resetting the timer and eventually clone the whole project.
  useEffect(() => {
    return useGraphStore.subscribe((state, previous) => {
      if (state.project && state.project !== previous.project) {
        scheduleProjectAutosave(state.project);
      }
    });
  }, []);

  // Reading position (activeIdx) lives in a transient store the project
  // subscription can't see — wheel-stepping bullets and then closing the tab
  // would lose the position without this. The fold reads the store fresh at
  // write time; the debounce absorbs wheel bursts.
  useEffect(() => {
    return useActiveIdxStore.subscribe(() => {
      const p = useGraphStore.getState().project;
      if (p) scheduleReadingPositionAutosave(p);
    });
  }, []);

  // Ask the coordinator to push its latest small patch before the browser
  // backgrounds the page. OPFS completion is still browser-controlled, but
  // this removes the ordinary 300ms wait without blocking navigation.
  useEffect(() => {
    const flushLatest = () => {
      const project = useGraphStore.getState().project;
      if (project) {
        void flushProjectPersistence(project).catch((error) => {
          console.error('[scatter] could not flush the active project', error);
        });
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) flushLatest();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flushLatest);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', flushLatest);
    };
  }, []);

  return bootstrap;
}
