/**
 * Project export/import — a `.scatter.zip` bundle containing:
 *   - `project.json`        a versioned envelope wrapped around the Project
 *   - `assets/<assetId>`    raw media bytes for every referenced upload
 *
 * jszip is dynamically imported: it's already in the dependency tree (docx
 * pulls it in for the editor's .docx export, itself lazily loaded), so this
 * adds nothing to the initial bundle and nothing new to node_modules.
 *
 * Backwards/forwards compat: the envelope carries `formatVersion`; imports
 * reject only files claiming a NEWER version. Within a version, optional
 * project fields follow the app-wide "undefined = derive/fallback" convention
 * (see types.ts), so older exports keep importing as the schema grows.
 */
import type { Project } from '@/store/types';
import { stripTransient } from '@/opfs/projectIO';
import { loadAsset } from '@/opfs/assetsIO';
import { loadSourceAsset } from '@/opfs/sourceAssetsIO';
import { collectReferencedProjectAssets } from './projectBranch';

export const PROJECT_EXPORT_FORMAT = 'scatter-project';
export const PROJECT_EXPORT_VERSION = 1;

/** Import failure whose `message` is written for the user (shown in an alert). */
export class ProjectImportError extends Error {}

const NOT_A_PROJECT =
  'This file doesn’t look like a Scatter project export (.scatter.zip).';

interface ProjectEnvelope {
  format: typeof PROJECT_EXPORT_FORMAT;
  formatVersion: number;
  exportedAt: number;
  project: Project;
}

/** Zip up `project` (transient fields stripped) + its referenced asset bytes.
 *  Assets whose OPFS file is missing are skipped — same as the orphan-sweep
 *  semantics on load. */
export async function buildProjectZip(project: Project): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const clean = stripTransient(project);
  const envelope: ProjectEnvelope = {
    format: PROJECT_EXPORT_FORMAT,
    formatVersion: PROJECT_EXPORT_VERSION,
    exportedAt: Date.now(),
    project: clean,
  };
  zip.file('project.json', JSON.stringify(envelope));
  const referenced = collectReferencedProjectAssets(clean);
  for (const assetId of referenced.media) {
    const blob = await loadAsset(project.id, assetId);
    // STORE (no re-compression): media bytes are already compressed formats.
    if (blob) zip.file(`assets/${assetId}`, blob, { compression: 'STORE' });
  }
  for (const assetId of [...referenced.sourceEager, ...referenced.sourceLazy]) {
    const blob = await loadSourceAsset(project.id, assetId);
    if (!blob) throw new ProjectImportError(`A project source asset is missing (${assetId}).`);
    zip.file(`sources/${assetId}`, blob, { compression: 'STORE' });
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** Read a picked file's bytes back into { project, assets }. Throws
 *  ProjectImportError (user-facing message) on anything malformed. */
export async function parseProjectZip(
  bytes: ArrayBuffer,
): Promise<{ project: Project; assets: Map<string, Blob>; sourceAssets: Map<string, Blob> }> {
  const { default: JSZip } = await import('jszip');

  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ProjectImportError(NOT_A_PROJECT);
  }

  const entry = zip.file('project.json');
  if (!entry) throw new ProjectImportError(NOT_A_PROJECT);

  let raw: unknown;
  try {
    raw = JSON.parse(await entry.async('text'));
  } catch {
    throw new ProjectImportError(NOT_A_PROJECT);
  }

  const project = validateEnvelope(raw);

  // Collect only the asset bytes the project actually references — anything
  // else in the zip would just be swept as an orphan after import anyway.
  const referenced = collectReferencedProjectAssets(project);
  const wanted = referenced.media;
  const wantedSources = new Set([...referenced.sourceEager, ...referenced.sourceLazy]);
  const assets = new Map<string, Blob>();
  const sourceAssets = new Map<string, Blob>();
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    const id = /^assets\/([^/]+)$/.exec(file.name)?.[1];
    if (!id || !wanted.has(id)) continue;
    assets.set(id, await file.async('blob'));
  }
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    const id = /^sources\/([^/]+)$/.exec(file.name)?.[1];
    if (!id || !wantedSources.has(id)) continue;
    sourceAssets.set(id, await file.async('blob'));
  }
  const missingSources = [...wantedSources].filter((id) => !sourceAssets.has(id));
  if (missingSources.length) {
    throw new ProjectImportError('This project export is missing source material or its search index.');
  }
  return { project, assets, sourceAssets };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate just enough structure that loading the project can't crash the app
 * (loadIntoStore dereferences node positions/versions unguarded), defaulting
 * everything optional. Unknown extra fields are KEPT — a file exported by a
 * newer Scatter with additions (but the same formatVersion) round-trips.
 */
function validateEnvelope(raw: unknown): Project {
  if (!isRecord(raw) || raw.format !== PROJECT_EXPORT_FORMAT || typeof raw.formatVersion !== 'number') {
    throw new ProjectImportError(NOT_A_PROJECT);
  }
  if (raw.formatVersion > PROJECT_EXPORT_VERSION) {
    throw new ProjectImportError(
      'This project was exported by a newer version of Scatter — refresh this app and try again.',
    );
  }
  const p = raw.project;
  if (!isRecord(p) || typeof p.rootNodeId !== 'string'
      || !isRecord(p.nodes) || !isRecord(p.arrows) || !isRecord(p.groups)) {
    throw new ProjectImportError('This Scatter export is damaged (missing core project data).');
  }
  for (const node of Object.values(p.nodes)) {
    const pos = isRecord(node) ? node.position : null;
    if (!isRecord(node)
        || typeof node.id !== 'string'
        || !Array.isArray(node.versions)
        || typeof node.currentVersionIndex !== 'number'
        || !isRecord(pos) || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
      throw new ProjectImportError('This Scatter export is damaged (bad node data).');
    }
  }

  // Defaults for whatever this export predates (or a hand-edit broke).
  const vp = isRecord(p.viewport) ? p.viewport : {};
  const viewport =
    typeof vp.x === 'number' && typeof vp.y === 'number' && typeof vp.zoom === 'number'
      ? { x: vp.x, y: vp.y, zoom: vp.zoom }
      : { x: 0, y: 0, zoom: 1 };
  const selection = Array.isArray(p.selection)
    ? p.selection.filter((s): s is string => typeof s === 'string')
    : [];
  const name = typeof p.name === 'string' && p.name.trim() ? p.name : 'Imported project';
  const createdAt = typeof p.createdAt === 'number' ? p.createdAt : Date.now();
  const updatedAt = typeof p.updatedAt === 'number' ? p.updatedAt : Date.now();

  return {
    ...(p as unknown as Project),
    name, createdAt, updatedAt, viewport, selection,
  };
}
