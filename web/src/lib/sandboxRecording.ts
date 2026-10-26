/* -------------------------------------------------------------------------
 * Sandbox physics recording / replay.
 *
 * Records per-tick node positions and arrow anchor positions from the
 * physics worker, saves to localStorage, replays by feeding the recorded
 * tick stream back into the same listeners used by the live render path.
 *
 * Phase 1 (this iteration): visual replay only — recorded frames play
 * back at recorded timestamps. Useful for "did the rope I saw bugging
 * out look like this?".
 *
 * Phase 2 (future): replay re-runs the physics with a fresh worker,
 * feeding it recorded user input events, so the user can tune physics
 * config and see whether the recorded bug still reproduces.
 * ------------------------------------------------------------------------*/

import type { PhysicsConfig, Project } from '@/store/types';
import type { InputEvent } from '@/physics/physicsClient';

export type RecPosition = { id: string; x: number; y: number };
export type RecAnchor = { x: number; y: number };

/** A single physics-tick snapshot. */
export interface RecFrame {
  /** ms since recording start */
  t: number;
  nodes: RecPosition[];
  arrows: Record<string, RecAnchor[]>;
}

/** A user-input event with a recording-relative timestamp. */
export interface RecInput {
  /** ms since recording start */
  t: number;
  event: InputEvent;
}

/** A recorded physics session. Saved as JSON in localStorage. */
export interface Recording {
  id: string;
  name: string;
  createdAt: number;
  durationMs: number;
  /** Initial project state (cloned at record start). */
  initialProject: Project;
  /** Physics config snapshot at record start. */
  physicsConfig: PhysicsConfig;
  /** Per-tick position snapshots — useful for visualizing what the user
   *  saw. NOT used to drive re-simulation; re-sim drives from `inputs`. */
  frames: RecFrame[];
  /** User-input event stream (drags, arrow drags). Re-simulation replays
   *  these against the current physics config. Optional for backward
   *  compatibility with recordings made before input capture existed. */
  inputs?: RecInput[];
}

const STORAGE_KEY = 'scatter.sandbox-recordings';

function safeLoadAll(): Recording[] {
  if (typeof window === 'undefined') return [];
  try {
    // Migration: key was renamed rabbit-hole.* → scatter.*; fall back to the
    // old key so dev recordings made before the rename still load.
    const raw = window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem('rabbit-hole.sandbox-recordings');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as Recording[];
  } catch {
    return [];
  }
}

function safePersistAll(recs: Recording[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recs));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[sandbox-recording] localStorage save failed', e);
  }
}

/** List recordings sorted newest-first. */
export function listRecordings(): Recording[] {
  const recs = safeLoadAll();
  recs.sort((a, b) => b.createdAt - a.createdAt);
  return recs;
}

export function saveRecording(rec: Recording): void {
  const recs = safeLoadAll();
  const idx = recs.findIndex((r) => r.id === rec.id);
  if (idx >= 0) recs[idx] = rec;
  else recs.push(rec);
  safePersistAll(recs);
}

export function deleteRecording(id: string): void {
  const recs = safeLoadAll().filter((r) => r.id !== id);
  safePersistAll(recs);
}

export function getRecording(id: string): Recording | null {
  return safeLoadAll().find((r) => r.id === id) ?? null;
}

/**
 * Live recorder: pushes frames as physics ticks arrive. Caller decides
 * when to start/stop and what initial state to associate with the
 * recording.
 */
export class LiveRecorder {
  private startTime = 0;
  private frames: RecFrame[] = [];
  private inputs: RecInput[] = [];
  private active = false;

  start(): void {
    this.startTime = performance.now();
    this.frames = [];
    this.inputs = [];
    this.active = true;
  }

  pushFrame(nodes: RecPosition[], arrows: Record<string, RecAnchor[]>): void {
    if (!this.active) return;
    this.frames.push({
      t: performance.now() - this.startTime,
      nodes,
      arrows,
    });
  }

  pushInput(event: InputEvent): void {
    if (!this.active) return;
    this.inputs.push({
      t: performance.now() - this.startTime,
      event,
    });
  }

  /** Stop and finalize. Returns the captured frames + duration. */
  stop(): { frames: RecFrame[]; inputs: RecInput[]; durationMs: number } {
    this.active = false;
    // Duration is whichever stream ran longer.
    const lastFrame = this.frames.length > 0 ? this.frames[this.frames.length - 1]!.t : 0;
    const lastInput = this.inputs.length > 0 ? this.inputs[this.inputs.length - 1]!.t : 0;
    const durationMs = Math.max(lastFrame, lastInput);
    return { frames: this.frames, inputs: this.inputs, durationMs };
  }

  isActive(): boolean { return this.active; }

  /** Frames so far — useful for "live frame count" display. */
  frameCount(): number { return this.frames.length; }
  inputCount(): number { return this.inputs.length; }
}
