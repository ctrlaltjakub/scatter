export const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '');

export const MEDIA_EXPLAINER =
  '**Describe an image** to generate, **paste a direct link** to an **image, GIF, or video file**, or **upload** one. ' +
  `You can also **drag a file** onto this card, or **paste an image (or screenshot)** with **${isMac ? '⌘' : 'Ctrl'}-V**. ` +
  '**YouTube** and **Vimeo** links work too.';

/** Refresh only the built-in copy saved by older versions, never user text. */
export function mediaInstructionsForDisplay(body: string): string {
  return body.replace(/\*\*/g, '') === MEDIA_EXPLAINER.replace(/\*\*/g, '') ? MEDIA_EXPLAINER : body;
}
