/**
 * Media-node actions: spawn an empty media node, attach media to it (from a
 * file / link / paste / drop), and clear it back to the chooser.
 *
 * A media node is a normal ScatterNode (`type:'media'`) — these helpers just
 * fill in `node.media` + size it. NO AI runs. Binary bytes go to OPFS via
 * assetsIO; only the small `MediaRef` descriptor lives in the project.
 */
import { useGraphStore } from '@/store/useGraphStore';
import { useMediaUrlStore } from '@/store/useMediaUrlStore';
import { useMediaReloadStore } from '@/store/useMediaReloadStore';
import { newId } from './ids';
import { spawnNearParent } from './generate';
import { classifyFile, classifyLink } from './mediaDetect';
import { fitMediaToWidth, CHOOSER_MAX_W, MEDIA_CHOOSER_W } from './mediaSizing';
import { saveAsset } from '@/opfs/assetsIO';
import { fetchOEmbed } from './oembed';
import type { ImageQuestionContext, ScatterNode, NodeVersion, MediaRef } from '@/store/types';

import { MEDIA_EXPLAINER } from './mediaInstructions';
export { MEDIA_EXPLAINER, isMac } from './mediaInstructions';

// ── helpers ────────────────────────────────────────────────────────────────

function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim();
  return base || name || 'Media';
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? decodeURIComponent(seg.replace(/\.[^.]+$/, '')) : u.hostname;
  } catch {
    return 'Media';
  }
}

function measureImage(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function measureVideo(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => resolve(null);
    v.src = url;
  });
}

/** Write media + title onto a node as ONE undo entry, then size it (paused, so
 *  the size doesn't pollute undo). */
function setMedia(nodeId: string, media: MediaRef, header: string, opts?: { skipSize?: boolean }): void {
  const g = useGraphStore.getState();
  const node = g.project?.nodes[nodeId];
  if (!node) return;
  const cur = node.currentVersionIndex;
  g.updateNode(nodeId, {
    versions: node.versions.map((ver, i) => (i === cur ? { ...ver, media, header, body: '' } : ver)),
  });
  if (opts?.skipSize) return;
  const { width, bodyMaxHeight } =
    media.naturalWidth && media.naturalHeight
      ? fitMediaToWidth(media.naturalWidth, media.naturalHeight)
      : fitMediaToWidth(0, 0, CHOOSER_MAX_W); // unknown dims (embed) → 16:9
  useGraphStore.temporal.getState().pause();
  try {
    g.setVersionSize(nodeId, { width, bodyMaxHeight });
  } finally {
    useGraphStore.temporal.getState().resume();
  }
}

// ── spawn ────────────────────────────────────────────────────────────────

/** Spawn an empty media node connected to `parentId`. No AI. */
export function spawnMediaNode(parentId: string, sourceImage?: ImageQuestionContext): string {
  const proj = useGraphStore.getState().project;
  if (!proj) return '';
  const parent = proj.nodes[parentId];
  if (!parent) return '';
  const id = newId();
  const newNode: ScatterNode = {
    id,
    type: 'media',
    position: spawnNearParent(parent, Object.values(proj.nodes), undefined, undefined, sourceImage?.regions),
    frozen: false,
    groupId: parent.groupId,
    // Empty media nodes are a fixed width; spawn at it so the first paint is
    // already correct (no flash).
    versions: [{ header: 'Media', body: MEDIA_EXPLAINER, createdAt: Date.now(), generatedBy: 'media', contentType: 'media', width: MEDIA_CHOOSER_W }],
    currentVersionIndex: 0,
  };
  useGraphStore.getState().addNodeWithArrow(
    newNode,
    { id: newId(), fromNodeId: parentId, toNodeId: id, kind: 'auto', ...(sourceImage ? { sourceImage } : {}) },
  );
  useGraphStore.getState().requestPanTo(id, parentId, 'newNodes');
  return id;
}

// ── attach ─────────────────────────────────────────────────────────────────

export async function attachMediaFromFile(nodeId: string, file: File): Promise<void> {
  const proj = useGraphStore.getState().project;
  if (!proj) return;
  const cls = classifyFile(file);
  if (cls.kind === 'unsupported') {
    setMedia(
      nodeId,
      { source: 'asset', kind: 'image', mime: file.type, fileName: file.name, unsupportedReason: cls.reason },
      titleFromFileName(file.name),
      { skipSize: true },
    );
    return;
  }
  const assetId = newId();
  await saveAsset(proj.id, assetId, file);
  const objectUrl = URL.createObjectURL(file);
  useMediaUrlStore.getState().set(assetId, objectUrl);
  const dims = cls.kind === 'image' ? await measureImage(objectUrl) : await measureVideo(objectUrl);
  setMedia(
    nodeId,
    {
      source: 'asset',
      kind: cls.kind,
      assetId,
      mime: file.type,
      fileName: file.name,
      byteSize: file.size,
      naturalWidth: dims?.w,
      naturalHeight: dims?.h,
    },
    titleFromFileName(file.name),
  );
}

export async function attachMediaFromLink(nodeId: string, raw: string): Promise<void> {
  const cls = classifyLink(raw);
  if (cls.kind === 'unsupported') {
    setMedia(
      nodeId,
      { source: 'link', kind: 'image', url: raw.trim(), unsupportedReason: cls.reason },
      'Media',
      { skipSize: true },
    );
    return;
  }
  if (cls.kind === 'embed') {
    setMedia(
      nodeId,
      { source: 'embed', kind: 'embed', provider: cls.provider, embedId: cls.embedId, url: cls.url },
      cls.provider === 'youtube' ? 'YouTube video' : 'Vimeo video',
    );
    // Pull the real title + thumbnail in the background (paused — not a user
    // action, so it shouldn't add an undo entry).
    void fetchOEmbed(cls.provider, cls.embedId).then((res) => {
      if (!res) return;
      const g = useGraphStore.getState();
      const node = g.project?.nodes[nodeId];
      const cur = node?.currentVersionIndex ?? 0;
      const m = node?.versions[cur]?.media;
      if (!node || !m || m.embedId !== cls.embedId) return;
      useGraphStore.temporal.getState().pause();
      try {
        g.updateNode(nodeId, {
          versions: node.versions.map((ver, i) =>
            i === cur
              ? { ...ver, media: { ...m, thumbnailUrl: res.thumbnailUrl ?? m.thumbnailUrl }, header: res.title || ver.header }
              : ver,
          ),
        });
      } finally {
        useGraphStore.temporal.getState().resume();
      }
    });
    return;
  }
  // image / video link — live URL, no bytes saved (CORS).
  const url = cls.url;
  const dims = cls.kind === 'image' ? await measureImage(url) : await measureVideo(url);
  setMedia(
    nodeId,
    { source: 'link', kind: cls.kind, url, naturalWidth: dims?.w, naturalHeight: dims?.h },
    titleFromUrl(url),
  );
}

// ── Replace media (new version) ──────────────────────────────────────────────

/** Add a fresh empty chooser as a NEW version and switch to it, keeping the
 *  current media as an earlier, switchable version. The previous version's OPFS
 *  asset is untouched (still referenced), so switching back restores it. */
export function replaceMedia(nodeId: string): void {
  const g = useGraphStore.getState();
  const node = g.project?.nodes[nodeId];
  if (!node) return;
  const newVersion: NodeVersion = {
    header: 'Media',
    body: MEDIA_EXPLAINER,
    createdAt: Date.now(),
    generatedBy: 'media',
    width: MEDIA_CHOOSER_W,
  };
  g.updateNode(nodeId, {
    versions: [...node.versions, newVersion],
    currentVersionIndex: node.versions.length,
  });
}

// ── Reload non-generated media ──────────────────────────────────────────────

/** Reload the CURRENT version's media: drop the cached object URL so the bytes
 *  are re-read from OPFS, re-pull the embed title/thumbnail, and bump the
 *  reload counter so MediaView remounts and re-attempts the load (recovers a
 *  link that was temporarily unavailable). */
export function reloadMedia(nodeId: string): void {
  const g = useGraphStore.getState();
  const node = g.project?.nodes[nodeId];
  if (!node) return;
  const cur = node.currentVersionIndex;
  const media = node.versions[cur]?.media;
  if (!media) return;
  if (media.source === 'asset' && media.assetId) {
    useMediaUrlStore.getState().remove(media.assetId);
  }
  if (media.kind === 'embed' && media.provider && media.embedId) {
    const provider = media.provider;
    const embedId = media.embedId;
    void fetchOEmbed(provider, embedId).then((res) => {
      if (!res) return;
      const gg = useGraphStore.getState();
      const n = gg.project?.nodes[nodeId];
      const m = n?.versions[cur]?.media;
      if (!n || !m || m.embedId !== embedId) return;
      useGraphStore.temporal.getState().pause();
      try {
        gg.updateNode(nodeId, {
          versions: n.versions.map((ver, i) =>
            i === cur
              ? { ...ver, media: { ...m, thumbnailUrl: res.thumbnailUrl ?? m.thumbnailUrl }, header: res.title || ver.header }
              : ver,
          ),
        });
      } finally {
        useGraphStore.temporal.getState().resume();
      }
    });
  }
  useMediaReloadStore.getState().bump(nodeId);
}
