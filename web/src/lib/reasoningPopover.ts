interface Bounds { left: number; right: number; top: number; bottom: number; width: number }

/** The sidebar flyout sits beside the sidebar, not above its small trigger.
 * The collapsed-canvas flyout follows the entire corner panel, including sources. */
export function reasoningPopoverPosition({ panel, picker, below, viewportWidth, viewportHeight, height, preferredWidth }: {
  panel: Bounds;
  picker: Bounds;
  below: boolean;
  viewportWidth: number;
  viewportHeight: number;
  height: number;
  preferredWidth?: number;
}): { left: number; top: number; width: number | 'max-content'; maxWidth: number } {
  const gap = 4;
  const inset = 8;
  const available = Math.max(0, viewportWidth - inset * 2);
  if (preferredWidth) {
    const width = Math.min(preferredWidth, available);
    const left = below ? panel.right - width : panel.right + gap;
    return { left: Math.max(inset, Math.min(left, viewportWidth - width - inset)),
      top: Math.max(inset, Math.min(below ? panel.bottom + gap : picker.top, viewportHeight - height - inset)),
      width, maxWidth: available };
  }
  const left = below ? Math.max(inset, Math.min(panel.left, viewportWidth - inset - panel.width)) : panel.right + gap;
  const maxWidth = below ? Math.min(panel.width, available) : Math.max(0, viewportWidth - inset - left);
  const top = below ? panel.bottom + gap : picker.top;
  return {
    left,
    top: Math.max(inset, Math.min(top, viewportHeight - height - inset)),
    width: below ? maxWidth : 'max-content',
    maxWidth,
  };
}
