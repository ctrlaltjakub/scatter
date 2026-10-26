'use client';
import { useState } from 'react';
import { X } from 'lucide-react';

/**
 * Skippable notice shown (in place of the WebGL2 background renderer) when the
 * browser can't do WebGL2 — or when the dev "Simulate WebGL failure" flag is on.
 * Uses a dismissible banner: the dismissal is
 * ephemeral React state, so "Dismiss warning" / ✕ hides it until remounted; it
 * reappears next launch while WebGL2 stays unavailable. Rendered as a centered
 * card inside `.canvas-host` (which is `position: relative`).
 */
export function WebglUnavailableNotice() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const skip = () => setDismissed(true);
  return (
    <div className="webgl-notice" role="status">
      <button
        type="button"
        className="webgl-notice-close"
        onClick={skip}
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
      <div className="webgl-notice-title">Canvas graphics unavailable</div>
      <p className="webgl-notice-body">
        Scatter couldn&rsquo;t start <strong>WebGL2</strong>, the browser graphics
        system used for the canvas.
      </p>
      <p className="webgl-notice-body">
        Node auras, selection markers, and important labels are missing.{' '}
        <strong>Scatter cannot function correctly in this state.</strong>
      </p>
      <p className="webgl-notice-body">
        <strong>Possible causes:</strong> graphics acceleration is disabled, or
        your browser or graphics driver is unsupported or has failed.
      </p>
      <p className="webgl-notice-body">
        <strong>What to try:</strong> enable graphics or hardware acceleration
        in your browser settings, then restart the browser. If that doesn&rsquo;t
        help, update your browser and graphics driver, or try another browser.
      </p>
      <div className="webgl-notice-actions">
        <button type="button" className="btn btn-primary" onClick={skip}>
          Dismiss warning
        </button>
      </div>
    </div>
  );
}
