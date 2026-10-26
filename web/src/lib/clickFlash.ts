import { useEffect } from 'react';
import { installClickFlash } from './clickFlashRuntime';

/**
 * Brief press feedback: when the user presses something that shows a "clickable"
 * cursor, flash the mouse-pointer-click cursor for a moment, then revert.
 *
 * Rather than maintain a selector list of every clickable element, we read the
 * cursor actually shown under the pointer and flash only for the clickable ones.
 * Disabled controls are the exception: they use the ordinary clickable cursor
 * at rest, then flash the blocked cursor only when the user attempts a press.
 * Each --cur-* value
 * bakes in a native fallback keyword; the clickable cursors (--cur-pointer /
 * --cur-click = mouse-pointer-2, --cur-term = pointer+I-beam) fall back to
 * `default` / `pointer`, while text (`text`), pan (`grab`), move (`move`), and
 * resize (`*-resize`) do not — so those never flash.
 *
 * Implemented by toggling `sc-pressing` on <html>; the CSS rule
 * `html.sc-pressing * { cursor: var(--cur-press) !important }` does the rest.
 * Install ONCE at the app root so it covers canvas, sidebar and modals alike.
 */
export function useClickFlash(): void {
  useEffect(() => installClickFlash(document), []);
}
