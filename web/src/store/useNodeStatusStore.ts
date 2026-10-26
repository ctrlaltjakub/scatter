/**
 * Transient per-node AI-status text (Part F).
 *
 * generate.ts writes a short status here at each lifecycle stage
 * ("GENERATING", "MARKING CHIPS", …); the ASCII aura renderers poll this
 * store each frame and spell the status into the field near the node.
 * Runtime-only — never persisted, never in undo history.
 *
 * An entry lives from `setStatus` until its delete animation finishes:
 * `clearStatus` stamps `clearedAt` (begins the right-to-left wipe) but
 * keeps the entry; the renderer calls `removeStatus` once the wipe is
 * done (see statusFullyDeleted).
 */
import { create } from 'zustand';

export interface StatusEntry {
  text: string;
  /** performance.now() when this text first appeared. */
  startedAt: number;
  /** performance.now() when clearing began, or null while still active. */
  clearedAt: number | null;
}

interface State {
  statuses: Record<string, StatusEntry>;
  /** Additional independently animated processes. `statuses` remains the
   * compatibility lane for the node's main generation lifecycle. */
  processes: Record<string, Record<string, StatusEntry>>;
  /** Show `text` for a node (starts the type-on). No-op if the same text
   *  is already showing, so calling it per-chunk won't restart the anim. */
  setStatus: (nodeId: string, text: string) => void;
  /** Begin the delete animation (keeps the entry until removeStatus). */
  clearStatus: (nodeId: string) => void;
  /** Hard-remove an entry (called by the renderer once fully deleted). */
  removeStatus: (nodeId: string) => void;
  setProcessStatus: (nodeId: string, processId: string, text: string, restartAnimation?: boolean) => void;
  clearProcessStatus: (nodeId: string, processId: string) => void;
  removeProcessStatus: (nodeId: string, processId: string) => void;
}

const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export const useNodeStatusStore = create<State>((set, get) => ({
  statuses: {},
  processes: {},
  setStatus: (nodeId, text) => {
    const cur = get().statuses[nodeId];
    if (cur && cur.text === text && cur.clearedAt == null) return;
    set((s) => ({
      statuses: { ...s.statuses, [nodeId]: { text, startedAt: nowMs(), clearedAt: null } },
    }));
  },
  clearStatus: (nodeId) => {
    const cur = get().statuses[nodeId];
    if (!cur || cur.clearedAt != null) return;
    set((s) => ({
      statuses: { ...s.statuses, [nodeId]: { ...cur, clearedAt: nowMs() } },
    }));
  },
  removeStatus: (nodeId) => {
    set((s) => {
      if (!(nodeId in s.statuses)) return s;
      const next = { ...s.statuses };
      delete next[nodeId];
      return { statuses: next };
    });
  },
  setProcessStatus: (nodeId, processId, text, restartAnimation = true) => {
    const current = get().processes[nodeId]?.[processId];
    if (current?.text === text && current.clearedAt == null) return;
    set((state) => ({
      processes: {
        ...state.processes,
        [nodeId]: {
          ...state.processes[nodeId],
          [processId]: { text, startedAt: !restartAnimation && current && current.clearedAt == null
            ? current.startedAt : nowMs(), clearedAt: null },
        },
      },
    }));
  },
  clearProcessStatus: (nodeId, processId) => {
    const current = get().processes[nodeId]?.[processId];
    if (!current || current.clearedAt != null) return;
    set((state) => ({
      processes: {
        ...state.processes,
        [nodeId]: {
          ...state.processes[nodeId],
          [processId]: { ...current, clearedAt: nowMs() },
        },
      },
    }));
  },
  removeProcessStatus: (nodeId, processId) => {
    set((state) => {
      const nodeProcesses = state.processes[nodeId];
      if (!nodeProcesses?.[processId]) return state;
      const nextNode = { ...nodeProcesses };
      delete nextNode[processId];
      const processes = { ...state.processes };
      if (Object.keys(nextNode).length === 0) delete processes[nodeId];
      else processes[nodeId] = nextNode;
      return { processes };
    });
  },
}));
