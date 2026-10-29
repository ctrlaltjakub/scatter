'use client';
import { ArrowLeft, Monitor } from 'lucide-react';
import { useDeviceWarnings } from '@/hooks/useDeviceWarnings';
import { LANDING_URL } from '@/lib/deployment';

/**
 * Full-screen, blurred gate windows that steer Scatter toward desktop use:
 *  - touch tablet/phone (and not portrait)  → recommendation, dismissable once.
 *  - portrait/square window (any device)     → must widen; no override (live).
 *  - both at once                            → combined message; no override.
 * Exactly one shows at a time (combined takes precedence, then portrait, then
 * the dismissable tablet notice). Renders nothing on a landscape desktop.
 */
export function DeviceWarning() {
  const { isTouchTablet, isNarrow, tabletDismissed, dismissTablet } = useDeviceWarnings();

  const showCombined = isTouchTablet && isNarrow;
  const showNarrow = !isTouchTablet && isNarrow;
  const showTablet = isTouchTablet && !isNarrow && !tabletDismissed;

  if (!showCombined && !showNarrow && !showTablet) return null;

  let title: string;
  let body: string;
  if (showCombined) {
    title = 'Scatter needs a desktop and a wider window';
    body =
      'Scatter is built for a desktop computer (Linux, Windows, or macOS) with a keyboard and a ' +
      'trackpad or mouse — and for a landscape window that’s wider than it is tall. Please switch ' +
      'to a desktop and widen the window to continue.';
  } else if (showNarrow) {
    title = 'Please widen your window';
    body =
      'Scatter needs a landscape window — one that’s wider than it is tall. Make this window wider ' +
      '(or rotate your screen) and you’re good to go.';
  } else {
    title = 'Scatter works best on desktop';
    body =
      'Scatter is designed for a desktop computer (Linux, Windows, or macOS) with a keyboard and a ' +
      'trackpad or mouse. It can run on a tablet, but dragging, resizing and the cursor hints won’t ' +
      'feel right. For the best experience, open it on a desktop.';
  }

  return (
    <div className="device-warning-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="device-warning-card">
        <div className="device-warning-icon"><Monitor size={28} /></div>
        <h2 className="device-warning-title">{title}</h2>
        <p className="device-warning-body">{body}</p>
        <div className="device-warning-actions">
          <a className="btn btn-primary" href={LANDING_URL}>
            <ArrowLeft size={17} aria-hidden="true" /> Back to landing page
          </a>
          {showTablet && (
            <button type="button" className="btn btn-secondary" onClick={dismissTablet}>
              Use anyway
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
