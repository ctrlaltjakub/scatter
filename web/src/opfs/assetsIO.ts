/**
 * Binary media-asset persistence (OPFS), kept entirely separate from the
 * project JSON. A media node stores only an `assetId` string; the actual
 * image/video bytes live here at `projects/<projectId>/assets/<assetId>`.
 */
import { writeBlob, readBlob, deleteFile, removeDir, listDir } from './storage';

const assetPath = (projectId: string, assetId: string) =>
  `projects/${projectId}/assets/${assetId}`;

export async function saveAsset(projectId: string, assetId: string, blob: Blob): Promise<void> {
  await writeBlob(assetPath(projectId, assetId), blob);
}

export async function loadAsset(projectId: string, assetId: string): Promise<Blob | null> {
  return readBlob(assetPath(projectId, assetId));
}

export async function deleteAsset(projectId: string, assetId: string): Promise<void> {
  await deleteFile(assetPath(projectId, assetId));
}

/** Remove all assets for a project (on scatter delete / reset). */
export async function deleteProjectAssets(projectId: string): Promise<void> {
  await removeDir(`projects/${projectId}/assets`);
}

/** Delete any asset file no longer referenced by a live media node. Runs on
 *  scatter load — keeps undo-after-delete working within a session (we don't
 *  delete on node-delete) while preventing orphaned bytes from accumulating
 *  across reloads. */
export async function sweepOrphanAssets(projectId: string, liveAssetIds: Set<string>): Promise<void> {
  const names = await listDir(`projects/${projectId}/assets`);
  for (const name of names) {
    if (!liveAssetIds.has(name)) await deleteAsset(projectId, name);
  }
}
