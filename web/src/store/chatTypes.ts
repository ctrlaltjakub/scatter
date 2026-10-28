import type { ImageQuestionContext, InternalNodeSource, MediaRef, NodeSource, ProjectSourceMode } from './types';

/** Stable identities, rather than array positions, survive alternative answers,
 * deletion, project copies and asynchronous enrichment. */
export interface ChatAnswerRef {
  turnId: string;
  versionCreatedAt: number;
}

export interface ChatQuestionReference extends ChatAnswerRef {
  title: string;
  /** Exact visible passage captured when the question was submitted. */
  selectedText?: string;
}

/** Per-message input, never a project source or a searchable source index. */
export interface ChatAttachment {
  id: string;
  name: string;
  kind: 'image' | 'text';
  media?: MediaRef;
  text?: string;
  pageCount?: number;
}

export interface ChatToolActivity {
  id: string;
  name: string;
  summary: string;
  state: 'running' | 'complete' | 'failed' | 'stopped';
  resultSummary?: string;
}

export interface ChatParentSnapshot {
  id: string;
  nodeId: string;
  versionCreatedAt: number;
  fingerprint: string;
  header: string;
  body: string;
  sources?: NodeSource[];
  internalSources?: InternalNodeSource[];
  media?: MediaRef;
  selectedText?: string;
  imageContext?: ImageQuestionContext;
}

/** Stored on the ordinary NodeVersion so citations, evidence, persistence and
 * generation ownership keep using Scatter's version machinery. */
export interface ChatAnswerMetadata {
  turnId: string;
  question: string;
  informationChunking: boolean;
  state: 'generating' | 'complete' | 'stopped' | 'interrupted';
  error?: string;
  title: string;
  titleManual?: boolean;
  outlineParentTurnId?: string;
  providerId?: string;
  parentSnapshotId?: string;
  /** The exact prior alternatives used by THIS request. */
  contextPath: ChatAnswerRef[];
  reference?: ChatQuestionReference;
  attachments?: ChatAttachment[];
  sourceMode?: ProjectSourceMode;
  activeSourceIds?: string[];
  tools?: ChatToolActivity[];
  completedAt?: number;
}

export interface ChatTurn {
  id: string;
  versionCreatedAts: number[];
  /** Latest-turn selection is the continuation choice. Historic previews live
   * only in the runtime store and cannot rewrite this path. */
  selectedVersionCreatedAt: number;
}

export interface ChatMemory {
  id: string;
  summary: string;
  coveredPath: ChatAnswerRef[];
  createdAt: number;
}

export interface ChatCompaction {
  memory: ChatMemory;
  /** Visible event boundary, distinct from the older prefix being summarized. */
  afterTurnId?: string;
  /** Absent until another answer has consumed this memory. */
  consumedAt?: number;
  previousMemory?: ChatMemory;
}

export interface ChatConversation {
  title: string;
  titleManual?: boolean;
  informationChunking: boolean;
  turns: ChatTurn[];
  /** Semantic parent can differ from the graph parent of a fork. */
  parentNodeId?: string;
  /** Immutable image-selection context captured before the first question. */
  originSnapshotId?: string;
  parentSnapshots: Record<string, ChatParentSnapshot>;
  forkedFrom?: { nodeId: string } & ChatAnswerRef;
  memory?: ChatMemory;
  compactions: ChatCompaction[];
}

/** Saved locally, outside project files and sync. An unsent draft is not a
 * conversation turn or an app-level undo record. */
export interface ChatDraft {
  text: string;
  attachments?: ChatAttachment[];
  reference?: ChatQuestionReference;
  editingTurnId?: string;
  previousDraft?: { text: string; reference?: ChatQuestionReference; attachments?: ChatAttachment[] };
}
