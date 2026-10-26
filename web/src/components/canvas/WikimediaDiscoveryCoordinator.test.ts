import { describe, expect, it } from 'vitest';
import {
  WIKIMEDIA_AUTO_START_SETTLE_MS,
  isWikimediaVersionReadyForAutoSearch,
} from './WikimediaDiscoveryCoordinator';

describe('Wikimedia discovery scheduling', () => {
  it('waits for a newly appended version to settle before searching', () => {
    expect(isWikimediaVersionReadyForAutoSearch({
      body: 'Seed text that briefly exists before generation starts.',
      generatingThisVersion: false,
      isNewVersion: true,
      millisecondsSinceDetected: WIKIMEDIA_AUTO_START_SETTLE_MS - 1,
    })).toBe(false);
  });

  it('never searches an empty or actively generating version', () => {
    expect(isWikimediaVersionReadyForAutoSearch({
      body: '', generatingThisVersion: false, isNewVersion: false,
      millisecondsSinceDetected: 1_000,
    })).toBe(false);
    expect(isWikimediaVersionReadyForAutoSearch({
      body: 'Streaming text', generatingThisVersion: true, isNewVersion: true,
      millisecondsSinceDetected: 1_000,
    })).toBe(false);
  });

  it('accepts a completed version with usable context', () => {
    expect(isWikimediaVersionReadyForAutoSearch({
      body: 'Complete opening paragraph.', generatingThisVersion: false, isNewVersion: true,
      millisecondsSinceDetected: WIKIMEDIA_AUTO_START_SETTLE_MS,
    })).toBe(true);
    expect(isWikimediaVersionReadyForAutoSearch({
      body: 'Complete text from an older saved project.', generatingThisVersion: false,
      isNewVersion: false, millisecondsSinceDetected: 0,
    })).toBe(true);
  });
});
