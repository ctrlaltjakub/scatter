'use client';
/* -------------------------------------------------------------------------
 * Physics sandbox page.
 *
 * Spin-off of the main app for iterating on the physics engine. Loads a
 * deterministic 25-node project, lets the user spawn predictable
 * placeholder children, and records / replays per-tick physics state so
 * bugs can be captured and re-examined after physics tweaks.
 *
 * NOT wired up to OPFS — recordings live in localStorage; the project
 * resets to the canonical sandbox state on every reload.
 * ------------------------------------------------------------------------*/

import { useEffect, useRef, useState, useCallback } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useArrowAnchorsStore } from '@/store/useArrowAnchorsStore';
import { Canvas } from '@/components/canvas/Canvas';
import { Sidebar } from '@/components/Sidebar';
import { SettingsModal } from '@/components/SettingsModal';
import type { SettingsPageId } from '@/components/settings/settingsNavigation';
import { RecordingPanel } from '@/components/sandbox/RecordingPanel';
import {
  createSandboxProject,
  nextSandboxLetter,
  sandboxBody,
} from '@/lib/sandboxProject';
import { LiveRecorder, type Recording } from '@/lib/sandboxRecording';
import { DEFAULT_PHYSICS_CONFIG } from '@/physics/defaults';
import type { PhysicsClient } from '@/physics/physicsClient';
import type { ScatterNode, Arrow, Project } from '@/store/types';
import { useFullscreenSidebar } from '@/lib/useFullscreenSidebar';

const SPAWN_OFFSET = 480;

export default function SandboxPage() {
  const project = useGraphStore((s) => s.project);
  const setProject = useGraphStore((s) => s.setProject);
  const addNode = useGraphStore((s) => s.addNode);
  const addArrow = useGraphStore((s) => s.addArrow);
  const updateNode = useGraphStore((s) => s.updateNode);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const physicsConfig = useSettingsStore((s) => s.physicsConfig);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPageId | undefined>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useFullscreenSidebar({ collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed });
  const [recording, setRecording] = useState(false);
  const [liveFrameCount, setLiveFrameCount] = useState(0);
  const [replaying, setReplaying] = useState(false);
  const [replayProgress, setReplayProgress] = useState(0);

  const recorderRef = useRef<LiveRecorder>(new LiveRecorder());
  const physicsClientRef = useRef<PhysicsClient | null>(null);
  const replayRafRef = useRef<number | null>(null);

  useEffect(() => { void hydrate(); }, [hydrate]);

  // Load the canonical project on mount.
  useEffect(() => {
    setProject(createSandboxProject());
    // We intentionally don't depend on setProject — running once is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live frame count ticks while recording is active so the UI updates.
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      setLiveFrameCount(recorderRef.current.frameCount());
    }, 100);
    return () => window.clearInterval(id);
  }, [recording]);

  // -- Sandbox-flavored Canvas handlers ------------------------------------

  const handleReferenceClick = useCallback((parentId: string, term: string, _opts: { withModifier: boolean }) => {
    const proj = useGraphStore.getState().project;
    if (!proj) return;
    // If this term is already explored from this parent, just pan to it
    // (matches main app behavior — no duplicate spawns).
    const existing = Object.values(proj.arrows).find(
      (a) => a.kind === 'auto' && a.fromNodeId === parentId && a.label === term,
    );
    if (existing) {
      useGraphStore.getState().requestPanTo(existing.toNodeId);
      return;
    }
    const parent = proj.nodes[parentId];
    if (!parent) return;
    const headers = Object.values(proj.nodes).map((n) => n.versions[n.currentVersionIndex]!.header);
    const letter = nextSandboxLetter(headers);
    // Place new node offset from parent in a random-ish but deterministic-
    // looking direction (use existing node count as the seed for stability
    // across hot reloads of this file).
    const angle = (Object.keys(proj.nodes).length * 0.7) % (Math.PI * 2);
    const px = parent.position.x + Math.cos(angle) * SPAWN_OFFSET;
    const py = parent.position.y + Math.sin(angle) * SPAWN_OFFSET;
    const node: ScatterNode = {
      id: letter,
      type: 'term-click',
      position: { x: px, y: py },
      frozen: false,
      versions: [{
        header: letter,
        body: sandboxBody(letter),
        createdAt: Date.now(),
        generatedBy: 'term-click',
      }],
      currentVersionIndex: 0,
    };
    const arrow: Arrow = {
      id: `arrow_${parentId}_${letter}`,
      fromNodeId: parentId,
      toNodeId: letter,
      kind: 'auto',
      label: term,
    };
    addNode(node);
    addArrow(arrow);
    useGraphStore.getState().requestPanTo(letter);
  }, [addNode, addArrow]);

  const handleAskFollowUp = useCallback((parentId: string, _q: string) => {
    // Mirror reference-click for the sandbox — same deterministic spawn.
    handleReferenceClick(parentId, 'follow-up', { withModifier: false });
  }, [handleReferenceClick]);

  const handleModify = useCallback((_id: string, _instr: string) => {
    // No-op in the sandbox (no AI rewrites).
  }, []);

  // -- Recording wiring ----------------------------------------------------

  const onPhysicsTick = useCallback((
    positions: { id: string; x: number; y: number }[],
    arrowAnchors: Record<string, { x: number; y: number }[]>,
  ) => {
    const r = recorderRef.current;
    if (!r.isActive()) return;
    r.pushFrame(
      positions.map((p) => ({ id: p.id, x: p.x, y: p.y })),
      arrowAnchors,
    );
  }, []);

  const onPhysicsReady = useCallback((client: PhysicsClient | null) => {
    physicsClientRef.current = client;
    if (client) {
      // Subscribe to input events so we capture drag inputs into the recording.
      // Unsubscribe is tied to client lifetime — Canvas terminates the worker
      // on unmount, which drops all listeners anyway.
      client.onInput((evt) => {
        const r = recorderRef.current;
        if (r.isActive()) r.pushInput(evt);
      });
    }
  }, []);

  const handleStart = useCallback(() => {
    // Snapshot the project at record-start so re-sim begins from the
    // exact pre-drag state. Cloning here means later drags / spawns
    // can't mutate it.
    const proj = useGraphStore.getState().project;
    initialProjectRef.current = proj ? JSON.parse(JSON.stringify(proj)) : null;
    recorderRef.current.start();
    setLiveFrameCount(0);
    setRecording(true);
  }, []);

  const initialProjectRef = useRef<Project | null>(null);
  const handleStop = useCallback((): Recording | null => {
    const { frames, inputs, durationMs } = recorderRef.current.stop();
    setRecording(false);
    setLiveFrameCount(frames.length);
    const snapshot = initialProjectRef.current;
    if (!snapshot || (frames.length === 0 && inputs.length === 0)) return null;
    return {
      id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: new Date().toLocaleString(),
      createdAt: Date.now(),
      durationMs,
      // Snapshot was taken at record-start, so re-sim begins from the
      // pre-drag state rather than the post-drag state.
      initialProject: snapshot,
      physicsConfig: physicsConfig ?? DEFAULT_PHYSICS_CONFIG,
      frames,
      inputs,
    };
  }, [physicsConfig]);

  const stopReplay = useCallback(() => {
    if (replayRafRef.current !== null) {
      window.cancelAnimationFrame(replayRafRef.current);
      replayRafRef.current = null;
    }
    setReplaying(false);
    setReplayProgress(0);
  }, []);

  /**
   * Re-simulate a recording: reset the project to the saved initial state,
   * re-init the physics worker, then feed the recorded input event stream
   * back through the client at the original timestamps. Physics runs with
   * the CURRENT config (so tuning between replays is the point).
   */
  const handleReplay = useCallback((rec: Recording) => {
    const inputs = rec.inputs ?? [];
    if (inputs.length === 0) {
      // Old recording without input capture — nothing meaningful to re-sim.
      // eslint-disable-next-line no-alert
      window.alert(
        'This recording was captured before input events were tracked. ' +
        'Re-simulation needs the drag stream. Record a new one to use replay.',
      );
      return;
    }
    const client = physicsClientRef.current;
    if (!client) return;

    // 1. Restore project state. Cloning so the saved recording stays
    // pristine (the live store will mutate this object as physics ticks
    // come in).
    const fresh = JSON.parse(JSON.stringify(rec.initialProject)) as Project;
    setProject(fresh);
    useArrowAnchorsStore.getState().clear();
    // Pre-seed anchors so the very first re-sim tick has the saved
    // chain shapes (matches what physics will refine next).
    const seededAnchors: Record<string, { x: number; y: number }[]> = {};
    for (const [id, a] of Object.entries(fresh.arrows)) {
      if (a.anchors && a.anchors.length >= 2) seededAnchors[id] = a.anchors;
    }
    if (Object.keys(seededAnchors).length > 0) {
      useArrowAnchorsStore.getState().setAnchors(seededAnchors);
    }

    // 2. Re-init the physics worker with the saved initial state. The
    // worker's `init` handler resets nodes, links, and rope state — so
    // this is a clean slate at the original starting positions.
    client.init(
      Object.values(fresh.nodes).map((n) => ({
        id: n.id, x: n.position.x, y: n.position.y, frozen: n.frozen,
      })),
      Object.values(fresh.arrows).map((a) => ({
        source: a.fromNodeId, target: a.toNodeId,
        kind: a.kind, gravitates: !!a.gravitates,
        arrowId: a.id, anchors: a.anchors,
      })),
    );

    setReplaying(true);
    setReplayProgress(0);

    const startWall = performance.now();
    const totalMs = rec.durationMs || 1;
    let nextInputIdx = 0;

    const step = () => {
      const elapsed = performance.now() - startWall;
      // Flush all input events whose recorded time has now passed.
      while (
        nextInputIdx < inputs.length &&
        inputs[nextInputIdx]!.t <= elapsed
      ) {
        const evt = inputs[nextInputIdx]!.event;
        switch (evt.type) {
          case 'drag-start': client.dragStart(evt.id, evt.x, evt.y); break;
          case 'drag-move':  client.dragMove(evt.id, evt.x, evt.y); break;
          case 'drag-end':   client.dragEnd(evt.id); break;
          case 'drag-end-many': client.dragEndMany(evt.ids); break;
          case 'arrow-drag-start': client.arrowDragStart(evt.arrowId, evt.x, evt.y); break;
          case 'arrow-drag-move':  client.arrowDragMove(evt.arrowId, evt.x, evt.y); break;
          case 'arrow-drag-end':   client.arrowDragEnd(evt.arrowId); break;
        }
        nextInputIdx++;
      }
      setReplayProgress(Math.min(1, elapsed / totalMs));
      // Keep going until all inputs are flushed AND we've passed the
      // recorded duration (so post-drag settling is visible).
      if (nextInputIdx >= inputs.length && elapsed >= totalMs) {
        stopReplay();
        return;
      }
      replayRafRef.current = window.requestAnimationFrame(step);
    };
    replayRafRef.current = window.requestAnimationFrame(step);
  }, [setProject, stopReplay]);

  const handleReset = useCallback(() => {
    if (replayRafRef.current !== null) {
      window.cancelAnimationFrame(replayRafRef.current);
      replayRafRef.current = null;
    }
    setProject(createSandboxProject());
    useArrowAnchorsStore.getState().clear();
  }, [setProject]);

  // Cleanup any running replay on unmount.
  useEffect(() => {
    return () => {
      if (replayRafRef.current !== null) {
        window.cancelAnimationFrame(replayRafRef.current);
      }
    };
  }, []);

  if (!hydrated || !project) return null;

  return (
    <main className="flex flex-row h-full overflow-hidden" style={{ paddingBottom: 70 }}>
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
        onOpenSettings={(page) => { setSettingsPage(page); setSettingsOpen(true); }}
      />
      <div className="flex-1 relative overflow-hidden">
        <Canvas
          sidebarCollapsed={sidebarCollapsed}
          onOpenSettings={() => setSettingsOpen(true)}
          onReferenceClick={handleReferenceClick}
          onAskFollowUp={handleAskFollowUp}
          onModify={handleModify}
          onPhysicsTick={onPhysicsTick}
          onPhysicsReady={onPhysicsReady}
        />
      </div>
      <SettingsModal
        open={settingsOpen}
        initialPage={settingsPage}
        onClose={() => { setSettingsOpen(false); setSettingsPage(undefined); }}
      />
      <RecordingPanel
        recording={recording}
        liveFrameCount={liveFrameCount}
        replaying={replaying}
        replayProgress={replayProgress}
        onStart={handleStart}
        onStop={handleStop}
        onReplay={handleReplay}
        onStopReplay={stopReplay}
        onReset={handleReset}
      />
    </main>
  );
}
