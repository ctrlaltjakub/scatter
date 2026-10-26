'use client';
/**
 * Scatter interactive-background layer — renderer chooser.
 *
 * Only one renderer exists: the WebGL2 GPU renderer (AsciiAuraLayerGL). When the
 * browser can't create a WebGL2 context (old GPU/driver, or it's disabled), there
 * is no fallback — instead we show a skippable notice (WebglUnavailableNotice)
 * explaining which canvas features are missing and how to restore graphics.
 *
 * The dev flag `simulateWebglFailure` (Settings → Dev) forces the notice path so
 * the message can be previewed on hardware that does support WebGL2.
 *
 * The probe runs inside an effect and the choice renders from state: probing
 * during render (or reading `simulateWebglFailure` differently on server vs.
 * client) would risk a hydration mismatch. `available` starts null on the server
 * and the client's first render, so it stays hydration-safe.
 */
import { useEffect, useState, type RefObject } from 'react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { AsciiAuraLayerGL } from './AsciiAuraLayerGL';
import type { AuraSceneFactory } from '@/lib/asciiAura/sceneState';
import { WebglUnavailableNotice } from './WebglUnavailableNotice';

interface Props {
  containerRef: RefObject<HTMLDivElement | null>;
  sceneFactory?: AuraSceneFactory;
  renderAppOverlays?: boolean;
}

export function AsciiAuraLayer({ containerRef, sceneFactory, renderAppOverlays }: Props) {
  const simulateFail = useSettingsStore((s) => s.simulateWebglFailure);
  // null = still probing; true/false = WebGL2 (un)available.
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    // Free the probe context immediately — browsers cap live contexts.
    if (gl) gl.getExtension('WEBGL_lose_context')?.loseContext();
    setAvailable(!!gl);
  }, []);

  // Dev simulate flag short-circuits straight to the notice, even mid-probe.
  if (simulateFail || available === false) return <WebglUnavailableNotice />;
  if (available === null) return null; // probing
  return (
    <AsciiAuraLayerGL
      containerRef={containerRef}
      sceneFactory={sceneFactory}
      renderAppOverlays={renderAppOverlays}
    />
  );
}
