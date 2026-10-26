'use client';
import { useEffect, useState } from 'react';
import { Play, ImageOff, FileWarning, Maximize, ArrowLeft } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { useMediaUrlStore, getMediaUrl } from '@/store/useMediaUrlStore';
import { loadAsset } from '@/opfs/assetsIO';
import { isLargeVideo, SUPPORTED_SUMMARY } from '@/lib/mediaDetect';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { isStillImageMedia } from '@/lib/imageEditActions';
import { SelectableImage } from './SelectableImage';
import { replaceMedia } from '@/lib/mediaActions';

function ChooseOtherMedia({ nodeId }: { nodeId: string }) {
  return <button type="button" className="btn btn-secondary" onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); replaceMedia(nodeId); }}>
    <ArrowLeft size={15} aria-hidden="true" /> Choose another file or link
  </button>;
}

/**
 * Attached-media renderer. Shows the photo/video filling the card, or a calm
 * card for the edge cases (unsupported format, broken link, missing stored
 * copy). Embeds (YouTube/Vimeo) show a poster + play button and only mount the
 * iframe on click, so the canvas stays smooth.
 */
export function MediaView({ nodeId }: { nodeId: string }) {
  const media = useGraphStore((s) => {
    const n = s.project?.nodes[nodeId];
    return n ? n.versions[n.currentVersionIndex]?.media : undefined;
  });
  const projectId = useGraphStore((s) => s.project?.id ?? '');
  const assetUrl = useMediaUrlStore((s) => (media?.assetId ? s.urls[media.assetId] : undefined));
  const [missing, setMissing] = useState(false);
  const [broken, setBroken] = useState(false);
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  // Lazily load an OPFS asset's bytes into an object URL the first time it's
  // shown (also the recovery path after a scatter switch revoked the old URLs).
  const assetId = media?.assetId;
  const source = media?.source;
  const url = media?.url;
  useEffect(() => {
    setBroken(false);
    setMissing(false);
    if (source !== 'asset' || !assetId) return;
    if (getMediaUrl(assetId)) return;
    let cancelled = false;
    void loadAsset(projectId, assetId).then((blob) => {
      if (cancelled) return;
      if (blob) useMediaUrlStore.getState().set(assetId, URL.createObjectURL(blob));
      else setMissing(true);
    });
    return () => { cancelled = true; };
  }, [assetId, source, url, projectId]);

  if (!media) return null;

  if (media.unsupportedReason) {
    return (
      <div className="sc-media-card">
        <FileWarning size={18} aria-hidden="true" />
        <div className="sc-media-card-title">{media.unsupportedReason}</div>
        <div className="sc-media-card-sub">{SUPPORTED_SUMMARY}</div>
        <ChooseOtherMedia nodeId={nodeId} />
      </div>
    );
  }

  if (missing) {
    return (
      <div className="sc-media-card">
        <ImageOff size={18} aria-hidden="true" />
        <div className="sc-media-card-title">The stored copy is missing.</div>
        <ChooseOtherMedia nodeId={nodeId} />
      </div>
    );
  }

  if (broken) {
    return (
      <div className="sc-media-card">
        <ImageOff size={18} aria-hidden="true" />
        <div className="sc-media-card-title">{media.source === 'asset' ? 'This file could not be displayed.' : 'This link could not be loaded as an image or video.'}</div>
        {media.url && <div className="sc-media-card-sub sc-media-url">{media.url}</div>}
        <ChooseOtherMedia nodeId={nodeId} />
      </div>
    );
  }

  // Embed: poster + play button; iframe mounts only on click.
  if (media.kind === 'embed' && media.provider && media.embedId) {
    if (playing) {
      const embedSrc =
        media.provider === 'youtube'
          ? `https://www.youtube.com/embed/${media.embedId}?autoplay=1`
          : `https://player.vimeo.com/video/${media.embedId}?autoplay=1`;
      return (
        <div className="sc-media-view">
          <iframe
            className="sc-media-embed-frame"
            src={embedSrc}
            title="Embedded video"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        </div>
      );
    }
    return (
      <div className="sc-media-view sc-media-embed-poster" onClick={() => setPlaying(true)}>
        {media.thumbnailUrl && <img src={media.thumbnailUrl} alt="" className="sc-media-poster-img" draggable={false} />}
        <button type="button" className="sc-media-play-btn" aria-label="Play video">
          <Play size={28} />
        </button>
      </div>
    );
  }

  const src = media.source === 'asset' ? assetUrl : media.url;
  const showSpinner = loadedSource !== src && !broken;
  const largeVideo =
    media.kind === 'video' && media.source === 'asset' && !!media.byteSize && isLargeVideo(media.byteSize);

  return (
    <div className="sc-media-view">
      {showSpinner && <div className="sc-media-spinner" aria-label="Loading" />}
      {largeVideo && (
        <div className="sc-media-heavy">Large video — this will make the project heavier to load.</div>
      )}
      {src && media.kind === 'image' && (
        <>
          {isStillImageMedia(media) ? <SelectableImage key={src} nodeId={nodeId} src={src}
            onLoad={() => setLoadedSource(src)} onError={() => setBroken(true)} /> : <img
            src={src}
            alt=""
            className="sc-media-img"
            draggable={false}
            onLoad={() => setLoadedSource(src)}
            onError={() => setBroken(true)}
          />}
          <button
            type="button"
            className="sc-media-edit-overlay"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              useImageEditorStore.getState().openImageEditor(nodeId);
            }}
            data-tip="Open image editor"
            aria-label="Open image editor"
          >
            <Maximize size={20} aria-hidden="true" />
          </button>
        </>
      )}
      {src && media.kind === 'video' && (
        <video
          src={src}
          className="sc-media-video"
          controls
          preload="metadata"
          onLoadedMetadata={() => setLoadedSource(src)}
          onError={() => setBroken(true)}
        />
      )}
    </div>
  );
}
