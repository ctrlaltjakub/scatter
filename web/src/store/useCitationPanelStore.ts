import { create } from 'zustand';
import { useGraphStore } from '@/store/useGraphStore';
import { useChatRuntimeStore } from './useChatRuntimeStore';

function rememberChatPanel(nodeId: string | null, mode: 'conversation' | 'fact-check' | null): void {
  if (nodeId && useGraphStore.getState().project?.nodes[nodeId]?.chat) {
    useChatRuntimeStore.getState().view(nodeId, { rightPanelPreference: mode });
  }
}

/** Bring the node into focus when opening a review or history panel. */
function focusNode(nodeId: string): void {
  const proj = useGraphStore.getState().project;
  if (!proj) return;
  if (proj.selection.length === 1 && proj.selection[0] === nodeId) return;
  useGraphStore.getState().setSelection([nodeId]);
}

/** Newly opened right-side chrome should never be allowed to appear silently
 * off-screen. This request is runtime-only and deliberately preserves the
 * reader's current vertical position and zoom. */
function revealPanel(nodeId: string): void {
  useGraphStore.getState().requestPanelReveal(nodeId);
}

function cancelPanelReveal(nodeId: string | null): void {
  const request = useGraphStore.getState().panTo;
  if (
    request?.kind === 'node'
    && request.announceArrival === false
    && (!nodeId || request.id === nodeId)
  ) {
    useGraphStore.getState().requestPanTo(null);
  }
}

/**
 * Which node's evidence, image, or conversation panel is open.
 * Hidden by default (nodeId null). Only one panel open at a time —
 * opening another node's replaces it. Runtime only; never persisted.
 */
interface CitationPanelState {
  mode: 'fact-check' | 'wikimedia' | 'conversation' | null;
  nodeId: string | null;
  factVersionCreatedAt: number | null;
  activeFactUnitId: string | null;
  wikimediaVersionCreatedAt: number | null;
  close: (reason?: 'user' | 'navigation') => void;
  openConversation: (nodeId: string, reveal?: boolean) => void;
  openFact: (nodeId: string, versionCreatedAt: number, unitId?: string, reveal?: boolean) => void;
  setFactUnit: (nodeId: string, unitId: string) => void;
  openWikimedia: (nodeId: string, versionCreatedAt: number) => void;
  toggleWikimedia: (nodeId: string, versionCreatedAt: number) => void;
}

export const useCitationPanelStore = create<CitationPanelState>((set, get) => ({
  mode: null,
  nodeId: null,
  factVersionCreatedAt: null,
  activeFactUnitId: null,
  wikimediaVersionCreatedAt: null,
  close: (reason = 'user') => {
    if (reason === 'user' || get().mode === 'fact-check') rememberChatPanel(get().nodeId, null);
    cancelPanelReveal(get().nodeId);
    set({
      mode: null, nodeId: null,
      factVersionCreatedAt: null, activeFactUnitId: null,
      wikimediaVersionCreatedAt: null,
    });
  },
  openFact: (nodeId, versionCreatedAt, unitId, reveal = true) => {
    rememberChatPanel(nodeId, 'fact-check');
    const wasOpen = get().mode === 'fact-check'
      && get().nodeId === nodeId
      && get().factVersionCreatedAt === versionCreatedAt;
    focusNode(nodeId);
    set({
      mode: 'fact-check',
      nodeId,
      factVersionCreatedAt: versionCreatedAt,
      activeFactUnitId: unitId ?? null,
      wikimediaVersionCreatedAt: null,
    });
    if (!wasOpen && reveal) revealPanel(nodeId);
  },
  setFactUnit: (nodeId, unitId) => {
    if (get().mode === 'fact-check' && get().nodeId === nodeId) {
      set({ activeFactUnitId: unitId });
    }
  },
  openConversation: (nodeId, reveal = true) => {
    const wasOpen = get().mode === 'conversation' && get().nodeId === nodeId;
    focusNode(nodeId);
    rememberChatPanel(nodeId, 'conversation');
    set({ mode: 'conversation', nodeId, factVersionCreatedAt: null,
      activeFactUnitId: null, wikimediaVersionCreatedAt: null });
    if (!wasOpen && reveal) revealPanel(nodeId);
  },
  openWikimedia: (nodeId, versionCreatedAt) => {
    const wasOpen = get().mode === 'wikimedia'
      && get().nodeId === nodeId
      && get().wikimediaVersionCreatedAt === versionCreatedAt;
    focusNode(nodeId);
    set({
      mode: 'wikimedia', nodeId,
      factVersionCreatedAt: null, activeFactUnitId: null,
      wikimediaVersionCreatedAt: versionCreatedAt,
    });
    if (!wasOpen) revealPanel(nodeId);
  },
  toggleWikimedia: (nodeId, versionCreatedAt) => {
    if (
      get().mode === 'wikimedia'
      && get().nodeId === nodeId
      && get().wikimediaVersionCreatedAt === versionCreatedAt
    ) {
      get().close();
      return;
    }
    get().openWikimedia(nodeId, versionCreatedAt);
  },
}));
