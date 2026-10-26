'use client';
import { VersionCounter } from '@/components/VersionCounter';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ChevronLeft, ChevronRight, ExternalLink, ImagePlus, Maximize2,
  SquareArrowRight, ZoomIn, ZoomOut,
} from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { useWikimediaGalleryStore } from '@/store/useWikimediaGalleryStore';
import {
  IMAGE_EDITOR_ZOOM_STEP,
  MAX_IMAGE_EDITOR_ZOOM,
  MIN_IMAGE_EDITOR_ZOOM,
  ImageEditorViewportController,
  imageEditorSliderToZoom,
  imageEditorViewTransform,
  imageEditorZoomToSlider,
} from '@/lib/imageEditorViewport';
import { spawnFreeImageNode } from '@/lib/wikimediaSpawn';
import {
  displayFreeImageCredit,
  displayFreeImageCreator,
  freeImageLandingPage,
  freeImageSource,
  freeImageSourceId,
  freeImageSourceLabel,
  getFreeImageRecommendationSet,
} from '@/lib/freeImageRecommendations';
import { ResilientFreeImage } from './ResilientFreeImage';

export default function WikimediaGalleryOverlay() {
  const gallery = useWikimediaGalleryStore();
  const node = useGraphStore((state) => gallery.nodeId
    ? state.project?.nodes[gallery.nodeId]
    : undefined);
  const version = node?.versions.find((item) => item.createdAt === gallery.versionCreatedAt);
  const results = getFreeImageRecommendationSet(version)?.results ?? [];
  const index = Math.max(0, Math.min(gallery.index, results.length - 1));
  const result = results[index];
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const controller = useMemo(() => new ImageEditorViewportController(), []);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedThumbnailUrl, setLoadedThumbnailUrl] = useState<string | null>(null);

  useEffect(() => () => controller.destroy(), [controller]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !result) return;
    const configure = () => controller.configure({
      viewportWidth: element.clientWidth,
      viewportHeight: element.clientHeight,
      region: { x: 0, y: 0, width: result.width ?? 1600, height: result.height ?? 1200 },
    });
    configure();
    controller.fit();
    const observer = new ResizeObserver(configure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [controller, result]);

  useEffect(() => {
    setError(null);
    setSpawning(false);
    setLoadedThumbnailUrl(null);
  }, [result ? freeImageSourceId(result) : undefined, result?.thumbnailUrl]);

  useEffect(() => {
    if (!gallery.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        gallery.close();
      } else if (event.key === 'ArrowLeft' && index > 0) {
        gallery.setIndex(index - 1);
      } else if (event.key === 'ArrowRight' && index < results.length - 1) {
        gallery.setIndex(index + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [gallery.open, gallery.close, gallery.setIndex, index, results.length]);

  if (!gallery.open || !gallery.nodeId || !result) return null;
  const geometry = {
    viewportWidth: viewportRef.current?.clientWidth ?? 1,
    viewportHeight: viewportRef.current?.clientHeight ?? 1,
    region: { x: 0, y: 0, width: result.width ?? 1600, height: result.height ?? 1200 },
  };
  const transform = imageEditorViewTransform(view, geometry);
  const zoomPercent = Math.round(view.zoom * 100);
  const fitted = view.zoom <= MIN_IMAGE_EDITOR_ZOOM
    && Math.abs(view.panX) < 0.01
    && Math.abs(view.panY) < 0.01;
  const relevance = result.relevance;
  const creator = displayFreeImageCreator(result);

  const spawn = async () => {
    if (spawning) return;
    setSpawning(true);
    setError(null);
    try {
      await spawnFreeImageNode(gallery.nodeId!, result);
    } catch (spawnError) {
      setError((spawnError as Error).message);
    } finally {
      setSpawning(false);
    }
  };

  const closeFromOutside = (event: React.MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) gallery.close();
  };

  return (
    <>
      <div className="text-editor-backdrop wikimedia-gallery-backdrop" onClick={gallery.close} />
      <div className="text-editor-stage wikimedia-gallery-stage" onMouseDown={closeFromOutside}>
        <div className="text-editor-group wikimedia-gallery-group" onMouseDown={closeFromOutside}>
          <aside className="text-editor-panel wikimedia-gallery-panel" aria-label="Free image details">
            <div className="wikimedia-gallery-panel-scroll">
              <div className="wikimedia-gallery-topbar">
                <div className="versions-row wikimedia-gallery-version-row">
                  <div className="versions-row-cluster">
                    <button type="button" disabled={index === 0} onClick={() => gallery.setIndex(index - 1)} aria-label="Previous image">
                      <ChevronLeft size={14} />
                    </button>
                    <VersionCounter current={index + 1} total={results.length} noun="Image" />
                    <button type="button" disabled={index >= results.length - 1} onClick={() => gallery.setIndex(index + 1)} aria-label="Next image">
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="text-editor-exit wikimedia-gallery-exit"
                  onClick={gallery.close}
                  aria-label="Exit image viewer"
                  data-tip="Exit (Esc)"
                >
                  <SquareArrowRight size={16} /> Exit
                </button>
              </div>

              <h2 className="wikimedia-gallery-title" title={result.caption}>{result.caption}</h2>

              {relevance && <section className="wikimedia-gallery-section wikimedia-gallery-description">
                <h3>Why it fits</h3>
                <p className="wikimedia-gallery-relevance">{relevance}</p>
              </section>}

              <section className="wikimedia-gallery-section wikimedia-gallery-links">
                <h3>Links</h3>
                <a href={freeImageLandingPage(result)} target="_blank" rel="noreferrer" className="wikimedia-gallery-link">
                  View on {freeImageSourceLabel(result)} <ExternalLink size={13} />
                </a>
                <a href={result.originalUrl} target="_blank" rel="noreferrer" className="wikimedia-gallery-link">
                  Open original file <ExternalLink size={13} />
                </a>
              </section>

              <section className="wikimedia-gallery-section wikimedia-gallery-metadata">
                <h3>Image metadata</h3>
                <dl>
                  <MetadataRow label="Source" value={freeImageSourceLabel(result)} />
                  {result.fileTitle && <MetadataRow label="Commons file" value={result.fileTitle} />}
                  {result.pageId != null && <MetadataRow label="Wikimedia page ID" value={String(result.pageId)} />}
                  {freeImageSource(result) === 'openverse' && <MetadataRow label="Openverse ID" value={freeImageSourceId(result)} />}
                  {result.description && <MetadataRow label="Description" value={result.description} />}
                  <MetadataRow label="Caption" value={result.caption} />
                  {result.provider && <MetadataRow label="Provider" value={result.provider} />}
                  {(result.tags?.length ?? 0) > 0 && <MetadataRow label="Tags" value={result.tags!.join(', ')} />}
                  <MetadataRow
                    label="Creator"
                    value={creator ?? `See ${freeImageSourceLabel(result)}`}
                    href={creator ? result.creatorUrl : undefined}
                  />
                  <MetadataRow label="License" value={result.license} href={result.licenseUrl} />
                  {(result.width || result.height) && (
                    <MetadataRow label="Dimensions" value={`${result.width ?? '?'} × ${result.height ?? '?'} px`} />
                  )}
                  {result.mime && <MetadataRow label="Format" value={result.mime} />}
                  <MetadataRow label="Credit" value={displayFreeImageCredit(result)} />
                </dl>
              </section>
            </div>

            <button type="button" className="side-action wikimedia-gallery-spawn" disabled={spawning} onClick={() => { void spawn(); }}>
              <span className="side-action-icon"><ImagePlus size={15} /></span>
              {spawning ? 'Adding…' : 'Spawn media node'}
            </button>

            <div className="ie-navigation" role="group" aria-label="Image navigation">
              <button
                type="button"
                className="ie-nav-button"
                disabled={view.zoom <= MIN_IMAGE_EDITOR_ZOOM}
                onClick={() => controller.animateZoomBy(1 / IMAGE_EDITOR_ZOOM_STEP)}
                aria-label="Zoom out"
              >
                <ZoomOut size={16} />
              </button>
              <input
                type="range"
                className="ie-zoom-slider"
                min={0}
                max={100}
                step={0.1}
                value={imageEditorZoomToSlider(view.zoom)}
                onChange={(event) => controller.setZoom(imageEditorSliderToZoom(Number(event.target.value)))}
                data-tip={`Image zoom — ${zoomPercent}%`}
                aria-label="Image zoom"
                aria-valuetext={`${zoomPercent}%`}
              />
              <button
                type="button"
                className="ie-nav-button"
                disabled={view.zoom >= MAX_IMAGE_EDITOR_ZOOM}
                onClick={() => controller.animateZoomBy(IMAGE_EDITOR_ZOOM_STEP)}
                aria-label="Zoom in"
              >
                <ZoomIn size={16} />
              </button>
              <button
                type="button"
                className="ie-nav-button ie-nav-fit"
                disabled={fitted}
                onClick={() => controller.fit()}
                data-tip="Fit and center the image"
              >
                <Maximize2 size={12} aria-hidden="true" /> Fit
              </button>
            </div>
          </aside>

          <div className="text-editor-cardwrap wikimedia-gallery-cardwrap">
            <div className="text-editor-card wikimedia-gallery-card" role="dialog" aria-modal="true" aria-label="Free image">
              <div
                ref={viewportRef}
                className={'wikimedia-gallery-viewport' + (view.panning ? ' is-panning' : '')}
                onWheel={(event) => {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  controller.zoomByWheel(event.deltaY, { x: event.clientX - rect.left, y: event.clientY - rect.top });
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 && event.button !== 1) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
                  controller.setPanning(true);
                }}
                onPointerMove={(event) => {
                  const pointer = pointerRef.current;
                  if (!pointer || pointer.id !== event.pointerId) return;
                  controller.panBy(event.clientX - pointer.x, event.clientY - pointer.y);
                  pointerRef.current = { ...pointer, x: event.clientX, y: event.clientY };
                }}
                onPointerUp={(event) => {
                  if (pointerRef.current?.id !== event.pointerId) return;
                  pointerRef.current = null;
                  controller.setPanning(false);
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                }}
                onPointerCancel={() => {
                  pointerRef.current = null;
                  controller.setPanning(false);
                }}
                onLostPointerCapture={() => {
                  pointerRef.current = null;
                  controller.setPanning(false);
                }}
              >
                <ResilientFreeImage
                  result={result}
                  alt={result.caption}
                  className={loadedThumbnailUrl ? 'is-loaded' : ''}
                  loading="eager"
                  draggable={false}
                  onReady={(_image, url) => {
                    setLoadedThumbnailUrl(url);
                    controller.refresh();
                  }}
                  style={{
                    width: result.width ?? 1600,
                    height: result.height ?? 1200,
                    transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
                  }}
                />
              </div>
              {error && <div className="wikimedia-gallery-error" role="alert">{error}</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function MetadataRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="wikimedia-gallery-meta-row">
      <dt>{label}</dt>
      <dd>
        {href
          ? <a href={href} target="_blank" rel="noreferrer">{value} <ExternalLink size={11} /></a>
          : value}
      </dd>
    </div>
  );
}
