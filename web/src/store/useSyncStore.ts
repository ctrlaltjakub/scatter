import { create } from 'zustand';
import type {
  RemoteObject,
  RemoteProjectUpdate,
  SyncConfig,
  SyncLedger,
} from '@/sync/types';
import {
  defaultSyncConfig,
  defaultSyncLedger,
  loadSyncConfig,
  loadSyncLedger,
  saveSyncConfig,
  saveSyncLedger,
} from '@/sync/local';

export interface SyncHistoryEntry {
  object: RemoteObject;
  projectId?: string;
  editedAt: number;
  deleted?: boolean;
  restoredFrom?: number;
}

interface SyncState {
  hydrated: boolean;
  config: SyncConfig;
  ledger: SyncLedger;
  running: boolean;
  error: string | null;
  projectHistory: Record<string, SyncHistoryEntry[]>;
  preferenceHistory: SyncHistoryEntry[];
  remoteUpdate: RemoteProjectUpdate | null;
  googleDriveReconnectRequired: boolean;
  hydrate: () => Promise<void>;
  replaceConfig: (config: SyncConfig) => Promise<void>;
  patchConfig: (patch: Partial<SyncConfig>) => Promise<void>;
  replaceLedger: (ledger: SyncLedger) => Promise<void>;
  setRuntime: (patch: Partial<Pick<SyncState, 'running' | 'error' | 'projectHistory' | 'preferenceHistory' | 'remoteUpdate' | 'googleDriveReconnectRequired'>>) => void;
}

const initialConfig = defaultSyncConfig();
const initialLedger = defaultSyncLedger();

export const useSyncStore = create<SyncState>((set, get) => ({
  hydrated: false,
  config: initialConfig,
  ledger: initialLedger,
  running: false,
  error: null,
  projectHistory: {},
  preferenceHistory: [],
  remoteUpdate: null,
  googleDriveReconnectRequired: false,
  hydrate: async () => {
    if (get().hydrated) return;
    const [config, ledger] = await Promise.all([loadSyncConfig(), loadSyncLedger()]);
    set({ config, ledger, hydrated: true });
  },
  replaceConfig: async (config) => {
    await saveSyncConfig(config);
    set({ config });
  },
  patchConfig: async (patch) => {
    const config = { ...get().config, ...patch };
    await saveSyncConfig(config);
    set({ config });
  },
  replaceLedger: async (ledger) => {
    set({ ledger });
    await saveSyncLedger(ledger);
  },
  setRuntime: (patch) => set(patch),
}));
