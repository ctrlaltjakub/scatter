import { create } from 'zustand';
import type { ChatAnswerRef, ChatAttachment, ChatDraft } from './chatTypes';

function safeAttachments(value: unknown): ChatAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is ChatAttachment => !!item && typeof item === 'object'
    && typeof item.id === 'string' && typeof item.name === 'string'
    && (item.kind === 'text' && typeof item.text === 'string'
      || item.kind === 'image' && item.media?.source === 'asset' && typeof item.media.assetId === 'string'));
}

function safeReference(value: unknown): ChatDraft['reference'] {
  if (!value || typeof value !== 'object') return undefined;
  const ref = value as Record<string, unknown>;
  return typeof ref.turnId === 'string' && typeof ref.versionCreatedAt === 'number'
    && Number.isFinite(ref.versionCreatedAt) && typeof ref.title === 'string'
    ? { turnId: ref.turnId, versionCreatedAt: ref.versionCreatedAt, title: ref.title,
      ...(typeof ref.selectedText === 'string' ? { selectedText: ref.selectedText } : {}) } : undefined;
}
export function parseChatDraft(value: unknown): ChatDraft | undefined {
  if (!value || typeof value !== 'object' || typeof (value as ChatDraft).text !== 'string') return undefined;
  const draft = value as ChatDraft;
  return { text: draft.text, reference: safeReference(draft.reference), attachments: safeAttachments(draft.attachments),
    editingTurnId: typeof draft.editingTurnId === 'string' ? draft.editingTurnId : undefined,
    previousDraft: draft.previousDraft && typeof draft.previousDraft.text === 'string'
      ? { text: draft.previousDraft.text, reference: safeReference(draft.previousDraft.reference), attachments: safeAttachments(draft.previousDraft.attachments) } : undefined };
}

export interface ChatViewState {
  active?: ChatAnswerRef;
  previews: Record<string, number>;
  atBottom: boolean;
  jump: { turnId?: string; query?: string; nonce: number };
  scrollTop: number;
  compacting: boolean;
  activity?: string;
  error?: string;
  termErrors?: Record<number, string | undefined>;
  sourceTokens?: number;
  composerFocusNonce?: number;
  titleEditNonce?: number;
  rightPanelPreference?: 'conversation' | 'fact-check' | null;
}
export const EMPTY_CHAT_VIEW: ChatViewState = {
  previews: {}, atBottom: true, jump: { nonce: 0 }, scrollTop: 0, compacting: false,
};
export const EMPTY_CHAT_DRAFT: ChatDraft = { text: '' };
const draftKey = (projectId: string, nodeId: string) => `scatter.chat.draft.${projectId}.${nodeId}`;
const pending = new Map<string, ChatDraft>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function flushChatDrafts(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  for (const [key, draft] of pending) {
    try {
      if (!draft.text && !draft.reference && !draft.editingTurnId && !draft.attachments?.length) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(draft));
    } catch { /* A blocked/full local store must not break the composer. */ }
  }
  pending.clear();
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushChatDrafts);

interface ChatRuntimeState {
  views: Record<string, ChatViewState>;
  drafts: Record<string, ChatDraft>;
  view: (nodeId: string, patch: Partial<ChatViewState>) => void;
  jumpTo: (nodeId: string, turnId?: string, query?: string) => void;
  hydrateDraft: (projectId: string, nodeId: string) => void;
  setDraft: (projectId: string, nodeId: string, draft: ChatDraft) => void;
}
export const useChatRuntimeStore = create<ChatRuntimeState>((set, get) => ({
  views: {}, drafts: {},
  view: (nodeId, patch) => set((state) => {
    const current = state.views[nodeId] ?? EMPTY_CHAT_VIEW;
    if (Object.entries(patch).every(([key, value]) => current[key as keyof ChatViewState] === value)) return state;
    return { views: { ...state.views, [nodeId]: { ...current, ...patch } } };
  }),
  jumpTo: (nodeId, turnId, query) => {
    const view = get().views[nodeId] ?? EMPTY_CHAT_VIEW;
    get().view(nodeId, { jump: { turnId, query, nonce: view.jump.nonce + 1 } });
  },
  hydrateDraft: (projectId, nodeId) => {
    const key = draftKey(projectId, nodeId);
    if (get().drafts[key]) return;
    let draft = EMPTY_CHAT_DRAFT;
    try {
      draft = parseChatDraft(JSON.parse(localStorage.getItem(key) ?? 'null')) ?? EMPTY_CHAT_DRAFT;
    } catch { /* Old or inaccessible local drafts are optional. */ }
    set((state) => ({ drafts: { ...state.drafts, [key]: draft } }));
  },
  setDraft: (projectId, nodeId, draft) => {
    const key = draftKey(projectId, nodeId);
    set((state) => ({ drafts: { ...state.drafts, [key]: draft } }));
    pending.set(key, draft);
    if (!saveTimer) saveTimer = setTimeout(flushChatDrafts, 180);
  },
}));
export function getChatDraft(projectId: string, nodeId: string): ChatDraft {
  return useChatRuntimeStore.getState().drafts[draftKey(projectId, nodeId)] ?? EMPTY_CHAT_DRAFT;
}
export { draftKey as chatDraftKey };

/** Unsent local image drafts must survive the project's on-load asset sweep. */
export function localChatDraftAssetIds(projectId: string): Set<string> {
  const ids = new Set<string>();
  const collect = (draft: ChatDraft | undefined) => {
    for (const item of [...draft?.attachments ?? [], ...draft?.previousDraft?.attachments ?? []]) {
      if (item.media?.assetId) ids.add(item.media.assetId);
    }
  };
  const prefix = `scatter.chat.draft.${projectId}.`;
  for (const [key, draft] of Object.entries(useChatRuntimeStore.getState().drafts)) if (key.startsWith(prefix)) collect(draft);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        try { collect(parseChatDraft(JSON.parse(localStorage.getItem(key) ?? 'null'))); }
        catch { /* One malformed draft must not invalidate other drafts. */ }
      }
    }
  } catch { /* Runtime drafts still protect their assets if storage is blocked. */ }
  return ids;
}
