import type { Project, ProjectMeta, ProjectsIndex } from '@/store/types';
import { readJSON, writeJSON, deleteFile } from './storage';
import { stripTransient } from './projectIO';
import {
  evictLargeProject,
  flushLargeProject,
  patchLargeProject,
  readLargeJSON,
  writeLargeJSON,
} from './projectFileWorkerClient';
import type { ProjectFilePatch } from './projectPersistenceProtocol';
import { waitForProjectPersistence } from './projectPersistenceBarrier';

/**
 * Multi-scatter persistence. Each scatter (project) is its own OPFS file at
 * `projects/<id>.json`; a small registry at `projects/index.json` lists their
 * metadata plus which one is active. Only the active scatter's full file is
 * loaded at a time — see projectActions.ts for the switch flow.
 */

const INDEX_PATH = 'projects/index.json';
const fileFor = (id: string) => `projects/${id}.json`;

/** Extract the lightweight registry row for a project. */
export function metaOf(project: Project): ProjectMeta {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    ...(project.color ? { color: project.color } : {}),
  };
}

export async function loadProjectsIndex(): Promise<ProjectsIndex | null> {
  const idx = await readJSON<ProjectsIndex>(INDEX_PATH);
  if (!idx || !Array.isArray(idx.items)) return null;
  return idx;
}

export async function saveProjectsIndex(idx: ProjectsIndex): Promise<void> {
  await writeJSON(INDEX_PATH, idx);
}

export async function loadProjectById(id: string): Promise<Project | null> {
  await waitForProjectPersistence(id);
  const p = await readLargeJSON<Project>(fileFor(id));
  return p ? stripTransient(p) : null;
}

export async function saveProjectFile(project: Project): Promise<void> {
  await writeLargeJSON(fileFor(project.id), stripTransient(project));
}

export async function patchProjectFile(
  projectId: string,
  patch: ProjectFilePatch,
): Promise<boolean> {
  return patchLargeProject(fileFor(projectId), patch);
}

export async function flushProjectFileMirror(
  projectId: string,
  revision: number,
): Promise<boolean> {
  return flushLargeProject(fileFor(projectId), revision);
}

export async function evictProjectFileMirror(projectId: string): Promise<void> {
  await evictLargeProject(fileFor(projectId));
}

export async function deleteProjectFile(id: string): Promise<void> {
  await evictProjectFileMirror(id);
  await deleteFile(fileFor(id));
}
