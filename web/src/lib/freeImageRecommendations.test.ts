import { describe, expect, it } from 'vitest';
import {
  freeImageDisplayCandidates,
  getFreeImageRecommendationSet,
} from './freeImageRecommendations';

describe('free image recommendation compatibility', () => {
  it('adapts a Wikimedia-only saved version without mutating it', () => {
    const version = {
      header: 'Cells', body: 'Cells contain organelles.', createdAt: 1, generatedBy: 'term-click' as const,
      wikimediaImages: {
        schemaVersion: 1 as const, bodyFingerprint: 'body', providerId: 'p', model: 'm',
        searchedAt: 1, resultLimit: 5,
        results: [{
          pageId: 2, fileTitle: 'File:Cell.svg',
          filePageUrl: 'https://commons.wikimedia.org/wiki/File:Cell.svg',
          thumbnailUrl: 'https://upload.wikimedia.org/thumb.png',
          originalUrl: 'https://upload.wikimedia.org/cell.svg',
          caption: 'Cell', license: 'CC BY-SA 4.0', creditLine: 'Researcher',
        }],
      },
    };

    const adapted = getFreeImageRecommendationSet(version);
    expect(adapted).toMatchObject({
      schemaVersion: 2,
      sourceOutcomes: [{ source: 'wikimedia', status: 'success' }],
      results: [{ source: 'wikimedia', sourceId: 'File:Cell.svg' }],
    });
    expect(version.wikimediaImages.schemaVersion).toBe(1);
  });

  it('repairs stale Openverse thumbnails through the current proxy before the original asset', () => {
    expect(freeImageDisplayCandidates({
      source: 'openverse',
      sourceId: 'openverse-id',
      thumbnailUrl: 'https://api.openverse.org/v1/thumbs/old-route',
      originalUrl: 'https://provider.example/full.jpg',
      caption: 'A long-lived image',
      license: 'CC BY 4.0',
      creditLine: 'Creator',
    })).toEqual([
      'https://api.openverse.org/v1/thumbs/old-route',
      'https://api.openverse.org/v1/images/openverse-id/thumb/',
      'https://api.openverse.org/v1/images/openverse-id/thumb/?full_size=true',
      'https://provider.example/full.jpg',
    ]);
  });
});
