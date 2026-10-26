import type {
  Arrow,
  Group,
  NodeVersion,
  Project,
  ScatterNode,
} from '@/store/types';

export interface RecordPatch<T> {
  upsert: Record<string, T>;
  remove: string[];
}

export interface ProjectBasePatch {
  set: Record<string, unknown>;
  remove: string[];
}

export interface RuntimePersistenceOverlay {
  positions: Record<string, { x: number; y: number }>;
  anchors: Record<string, { x: number; y: number }[]>;
  activeBulletIdx: Record<string, number | null>;
}

export interface NodeFilePatch {
  set: Record<string, unknown>;
  remove: string[];
  versions?: {
    length: number;
    upsert: Record<string, NodeVersion>;
    update: Record<string, ProjectBasePatch>;
  };
}

export interface NodeRecordPatch extends RecordPatch<ScatterNode> {
  update: Record<string, NodeFilePatch>;
}

/** Runtime-only delta sent to the project-file worker. Saved JSON is unchanged. */
export interface ProjectFilePatch {
  revision: number;
  base: ProjectBasePatch;
  nodes: NodeRecordPatch;
  arrows: RecordPatch<Arrow>;
  groups: RecordPatch<Group>;
  runtime: RuntimePersistenceOverlay;
}

export type ProjectFileRequest = {
  id: number;
  type: 'read' | 'write' | 'patch' | 'flush' | 'evict' | 'continue-read';
  path?: string;
  data?: Project;
  patch?: ProjectFilePatch;
  revision?: number;
};

export type ProjectFileResponse = {
  id: number;
  ok: false;
  error?: string;
} | {
  id: number;
  ok: true;
  value?: unknown;
  phase?: 'start' | 'nodes' | 'complete';
};
