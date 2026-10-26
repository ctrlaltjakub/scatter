import { describe, expect, it } from 'vitest';
import { MEDIA_EXPLAINER, mediaInstructionsForDisplay } from './mediaInstructions';

describe('media instructions', () => {
  it('emphasizes actions, file types, paste shortcut and supported video sites', () => {
    for (const text of ['Describe an image', 'paste a direct link', 'image, GIF, or video file', 'upload', 'drag a file', 'YouTube', 'Vimeo']) {
      expect(MEDIA_EXPLAINER).toContain(`**${text}**`);
    }
    expect(MEDIA_EXPLAINER).toMatch(/\*\*(?:Ctrl|⌘)-V\*\*/);
  });
  it('updates legacy built-in copy without changing custom content', () => {
    expect(mediaInstructionsForDisplay(MEDIA_EXPLAINER.replace(/\*\*/g, ''))).toBe(MEDIA_EXPLAINER);
    expect(mediaInstructionsForDisplay('My own media instructions.')).toBe('My own media instructions.');
  });
});
