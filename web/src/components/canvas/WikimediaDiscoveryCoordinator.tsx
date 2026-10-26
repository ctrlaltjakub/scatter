'use client';
import { useEffect, useRef } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import {
  startWikimediaDiscovery,
  versionSupportsAutomaticFreeImages,
  wikimediaSearchAvailability,
} from '@/lib/wikimediaDiscovery';
import { getFreeImageRecommendationSet } from '@/lib/freeImageRecommendations';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { getGenerationSession } from '@/lib/generationSession';

export const WIKIMEDIA_AUTO_START_SETTLE_MS = 200;

export function isWikimediaVersionReadyForAutoSearch(input: {
  body: string;
  generatingThisVersion: boolean;
  isNewVersion: boolean;
  millisecondsSinceDetected: number;
  generationFailed?: boolean;
}): boolean {
  return input.body.trim().length > 0
    && !input.generatingThisVersion
    && !input.generationFailed
    && (!input.isNewVersion
      || input.millisecondsSinceDetected >= WIKIMEDIA_AUTO_START_SETTLE_MS);
}

function key(nodeId: string, createdAt: number): string {
  return `${nodeId}:${createdAt}`;
}

/** Background discovery coordinator. Versions present when a project opens are
 * treated as legacy and searched only on first focus. Versions created during
 * this session are searched automatically once their generation settles. */
export function WikimediaDiscoveryCoordinator({ enabled = true }: { enabled?: boolean }) {
  const automatic = useSettingsStore(state => state.autoFreeImages);
  const activeProjectId = useGraphStore((state) => state.project?.id ?? null);
  const legacyRef = useRef(new Set<string>());
  const newRef = useRef(new Set<string>());
  const detectedAtRef = useRef(new Map<string, number>());
  const scheduledRef = useRef(new Set<string>());

  useEffect(() => {
    const initial = useGraphStore.getState().project;
    legacyRef.current = new Set(
      initial
        ? Object.values(initial.nodes).flatMap((node) =>
            node.versions.map((version) => key(node.id, version.createdAt)))
        : [],
    );
    newRef.current = new Set();
    detectedAtRef.current = new Map();
    scheduledRef.current = new Set();
    let settleTimer: number | null = null;

    const inspectAfter = (delay: number) => {
      if (settleTimer != null) return;
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        inspect();
      }, Math.max(0, delay));
    };

    const inspect = () => {
      const project = useGraphStore.getState().project;
      if (!enabled || !automatic || !useSettingsStore.getState().autoFreeImages || !project || project.id !== activeProjectId) return;
      const now = Date.now();
      const selectedId = project.selection.length === 1 ? project.selection[0] : null;
      for (const node of Object.values(project.nodes)) {
        for (let index = 0; index < node.versions.length; index++) {
          const version = node.versions[index]!;
          const versionKey = key(node.id, version.createdAt);
          if (!legacyRef.current.has(versionKey) && !newRef.current.has(versionKey)) {
            newRef.current.add(versionKey);
            detectedAtRef.current.set(versionKey, now);
          }
          if (
            scheduledRef.current.has(versionKey)
            || getFreeImageRecommendationSet(version)
            || !versionSupportsAutomaticFreeImages(node, version)
          ) continue;
          const isNewVersion = newRef.current.has(versionKey);
          const detectedAt = detectedAtRef.current.get(versionKey) ?? now;
          const millisecondsSinceDetected = now - detectedAt;
          if (isNewVersion && millisecondsSinceDetected < WIKIMEDIA_AUTO_START_SETTLE_MS) {
            inspectAfter(WIKIMEDIA_AUTO_START_SETTLE_MS - millisecondsSinceDetected);
          }
          // A rewrite's source copy and provisional version coexist. Do not
          // mistake either for newly completed prose while the session owns
          // the node. The generation pipeline explicitly starts image search
          // once complete prose is ready, in parallel with term marking.
          const generatingThisVersion = !!node.generating
            || !!getGenerationSession(project.id, node.id);
          const ready = isWikimediaVersionReadyForAutoSearch({
            body: version.body,
            generatingThisVersion,
            isNewVersion,
            millisecondsSinceDetected,
            generationFailed: !!node.generationError,
          });
          const shouldStart = ready && (
            isNewVersion
            || (selectedId === node.id && node.currentVersionIndex === index)
          );
          if (!shouldStart || !wikimediaSearchAvailability().available) continue;
          scheduledRef.current.add(versionKey);
          void startWikimediaDiscovery(node.id, version.createdAt, { automatic: true });
        }
      }
    };

    inspect();
    const unsubscribe = useGraphStore.subscribe(inspect);
    const unsubscribeSettings = useSettingsStore.subscribe(inspect);
    const unsubscribeCatalog = useModelCatalogStore.subscribe(inspect);
    return () => {
      unsubscribe();
      unsubscribeSettings();
      unsubscribeCatalog();
      if (settleTimer != null) window.clearTimeout(settleTimer);
    };
  }, [activeProjectId, enabled, automatic]);

  return null;
}
