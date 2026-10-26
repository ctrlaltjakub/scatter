import { describe, expect, it } from 'vitest';
import { imageRegionBounds, imageRegionFromDrag, imageRegionPaths, normalizedImageRegions } from './imageRegions';
import { selectedImageEditPrompt, selectedImageEditReferenceMode, upgradeSelectedImageEditPrompt } from './imageRegionInput';
import { isStillImageMedia } from './imageEditActions';

describe('image region geometry', () => {
  it('clamps reverse/outside drags and rejects invalid or empty rectangles', () => {
    expect(imageRegionFromDrag({ x: .8, y: .7 }, { x: -.2, y: 2 })).toEqual({ x: 0, y: .7, width: .8, height: .30000000000000004 });
    expect(normalizedImageRegions([{ x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }])).toEqual([]);
    expect(imageRegionBounds([{ x: .1, y: .2, width: .1, height: .1 }, { x: .6, y: .7, width: .2, height: .3 }])).toEqual({ x: .1, y: .2, width: .7000000000000001, height: .8 });
  });

  it('outlines the union, without internal seams or covering unselected gaps', () => {
    const paths = imageRegionPaths([{ x: 0, y: 0, width: .5, height: 1 }, { x: .5, y: 0, width: .5, height: .5 }]);
    expect(paths.outline).not.toContain('M0.5,0V0.5');
    expect(paths.outline).toContain('M0.5,0.5V1');
    expect(paths.outline).toContain('M0.5,0.5H1');
    expect(paths.fill.match(/Z/g)).toHaveLength(2);
  });

  it('keeps whole-image prompts intact and distinguishes the original, location mask, and close-up', () => {
    expect(selectedImageEditPrompt('Make it blue', [])).toBe('Make it blue');
    const prompt = selectedImageEditPrompt('Make it blue', [{ x: .1, y: .2, width: .3, height: .4 }]);
    expect(prompt).toContain('FIRST image');
    expect(prompt).toContain('WHITE pixels identify the selected parts; BLACK pixels identify content to preserve');
    expect(prompt).toContain('THIRD image is a close-up');
    expect(prompt).toContain("THIRD image's crop occupies this bounding rectangle in the FIRST image: 1: left 10.00%, top 20.00%, width 30.00%, height 40.00%");
    expect(prompt).toContain('Return one complete edited FIRST image');
    expect(prompt).toContain('without a visible rectangular patch or seam');
    expect(prompt).toContain('left 10.00%, top 20.00%, width 30.00%, height 40.00%');
    expect(prompt).toContain('User instruction: Make it blue');
  });

  it('describes every selected region and the full crop location without treating gaps as editable', () => {
    const prompt = selectedImageEditPrompt('Make them blue', [
      { x: .1, y: .2, width: .2, height: .1 }, { x: .5, y: .5, width: .1, height: .2 },
    ]);
    expect(prompt).toContain('1: left 10.00%, top 20.00%, width 20.00%, height 10.00%; 2: left 50.00%, top 50.00%, width 10.00%, height 20.00%');
    expect(prompt).toContain('bounding rectangle in the FIRST image: 1: left 10.00%, top 20.00%, width 50.00%, height 50.00%');
    expect(prompt).toContain('gaps between separate regions are not selected');
    expect(prompt).toContain('Flat gray areas outside the selection are hidden content');
    expect(selectedImageEditPrompt('Make it blue', [{ x: NaN, y: 0, width: 1, height: 1 }])).toBe('Make it blue');
  });

  it('upgrades only the known legacy prompt wrapper and leaves current/custom prompts intact', () => {
    const regions = [{ x: .1, y: .2, width: .3, height: .4 }];
    const old = "Edit the FIRST image according to the user's instruction below. The SECOND image is a binary selection mask...\nUser instruction: Make it blue";
    const current = selectedImageEditPrompt('Make it blue', regions);
    expect(upgradeSelectedImageEditPrompt(old, regions)).toBe(current);
    expect(upgradeSelectedImageEditPrompt(current, regions)).toBe(current);
    expect(upgradeSelectedImageEditPrompt('Custom instruction: keep my words', regions)).toBe('Custom instruction: keep my words');
    expect(upgradeSelectedImageEditPrompt(old, [])).toBe(old);
    expect(upgradeSelectedImageEditPrompt(old.split('\n')[0]!, regions)).toBe(old.split('\n')[0]);
    expect(upgradeSelectedImageEditPrompt(current, regions, 'crop')).toBe(selectedImageEditPrompt('Make it blue', regions, 'crop'));
  });

  it('adjusts image numbering and instructions to the actual model input capacity', () => {
    const regions = [{ x: .1, y: .2, width: .3, height: .4 }];
    expect(selectedImageEditReferenceMode(3)).toBe('mask-and-crop');
    expect(selectedImageEditReferenceMode(16)).toBe('mask-and-crop');
    expect(selectedImageEditReferenceMode(2)).toBe('crop');
    for (const max of [1, 0, undefined, NaN, Infinity]) expect(selectedImageEditReferenceMode(max)).toBe('coordinates');
    const crop = selectedImageEditPrompt('Make it blue', regions, 'crop');
    expect(crop).toContain('SECOND image is a close-up');
    expect(crop).not.toContain('THIRD');
    expect(crop).not.toContain('binary selection mask');
    const coordinates = selectedImageEditPrompt('Make it blue', regions, 'coordinates');
    expect(coordinates).not.toMatch(/SECOND|THIRD|close-up|Flat gray/);
    expect(coordinates).toContain('left 10.00%, top 20.00%, width 30.00%, height 40.00%');
  });

  it('excludes GIFs, videos, embeds, unsupported images and empty nodes', () => {
    expect(isStillImageMedia(undefined)).toBe(false);
    expect(isStillImageMedia({ source: 'link', kind: 'image', url: 'https://example.com/a.GIF#image' })).toBe(false);
    expect(isStillImageMedia({ source: 'asset', kind: 'image', mime: 'IMAGE/GIF; charset=binary' })).toBe(false);
    expect(isStillImageMedia({ source: 'asset', kind: 'video' })).toBe(false);
    expect(isStillImageMedia({ source: 'embed', kind: 'image' })).toBe(false);
    expect(isStillImageMedia({ source: 'asset', kind: 'image', unsupportedReason: 'bad' })).toBe(false);
    expect(isStillImageMedia({ source: 'asset', kind: 'image', mime: 'image/png' })).toBe(true);
  });
});
