import { deleteFile, listDir, readBlob, removeDir, writeBlob } from './storage';
import { loadAsset } from './assetsIO';

const sourceAssetPath = (projectId: string, assetId: string) => (
  `projects/${projectId}/sources/${assetId}`
);

export async function saveSourceAsset(
  projectId: string,
  assetId: string,
  blob: Blob,
): Promise<void> {
  await writeBlob(sourceAssetPath(projectId, assetId), blob);
}

export async function loadSourceAsset(projectId: string, assetId: string): Promise<Blob | null> {
  // A pre-sources sync client sees the compatibility union in `assetIds` and
  // stores unknown source blobs in the legacy media directory. Reading that
  // location as a fallback keeps the project recoverable after upgrading.
  return await readBlob(sourceAssetPath(projectId, assetId)) ?? loadAsset(projectId, assetId);
}

export async function deleteSourceAsset(projectId: string, assetId: string): Promise<void> {
  await deleteFile(sourceAssetPath(projectId, assetId));
}

export async function copySourceAsset(
  sourceProjectId: string,
  destinationProjectId: string,
  assetId: string,
): Promise<void> {
  const blob = await loadSourceAsset(sourceProjectId, assetId);
  if (!blob) throw new Error(`A source asset could not be read (${assetId}).`);
  await saveSourceAsset(destinationProjectId, assetId, blob);
}

export async function sweepOrphanSourceAssets(
  projectId: string,
  liveAssetIds: ReadonlySet<string>,
): Promise<void> {
  for (const assetId of await listDir(`projects/${projectId}/sources`)) {
    if (!liveAssetIds.has(assetId)) await deleteSourceAsset(projectId, assetId);
  }
}

export async function deleteProjectSourceAssets(projectId: string): Promise<void> {
  await removeDir(`projects/${projectId}/sources`);
}
