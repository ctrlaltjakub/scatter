import { describe, expect, it } from 'vitest';
import type { ProjectSource, ProjectSourceLibrary } from '@/store/types';
import {
  activeProjectSources,
  effectiveSourceMode,
  publishReadySource,
  removeReadySource,
  reorderSourceIds,
  withAllSourcesChecked,
  withSourceChecked,
  withSourceMode,
} from './projectSources';

function source(id: string, title = id): ProjectSource {
  return {
    id, title, kind: 'text', checked: true, createdAt: 1,
    contentHash: `hash-${id}`, activeRevisionId: `rev-${id}`,
    revisions: {
      [`rev-${id}`]: {
        id: `rev-${id}`, createdAt: 1, status: 'ready',
        contentAssetId: `content-${id}`, keywordIndexAssetId: `keyword-${id}`,
        index: {
          formatVersion: 1,
          embeddingModel: 'test-model',
          embeddingRevision: 'test',
          dimensions: 2,
        },
      },
    },
  };
}

const empty = (): ProjectSourceLibrary => ({ mode: 'ignore', order: [], sources: {} });

describe('project source choices', () => {
  it('makes the first ready source active and remembers Use', () => {
    const library = publishReadySource(empty(), source('a'));
    expect(library.mode).toBe('use');
    expect(library.rememberedNonIgnoreMode).toBe('use');
    expect(activeProjectSources(library).map((item) => item.id)).toEqual(['a']);
  });

  it('presents Ignore when nothing is checked without losing Only', () => {
    const initial = withSourceMode(publishReadySource(empty(), source('a')), 'only');
    const unchecked = withAllSourcesChecked(initial, false);
    expect(effectiveSourceMode(unchecked)).toBe('ignore');
    expect(unchecked.mode).toBe('only');
    expect(effectiveSourceMode(withSourceChecked(unchecked, 'a', true))).toBe('only');
  });

  it('reorders independently from checks and leaves a deletion tombstone', () => {
    let library = publishReadySource(publishReadySource(empty(), source('a')), source('b'));
    library = reorderSourceIds(library, 'a', 'b');
    expect(library.order).toEqual(['a', 'b']);
    library = removeReadySource(library, 'a', 1234);
    expect(library.sources.a).toBeUndefined();
    expect(library.tombstones?.a).toEqual({ deletedAt: 1234 });
  });
});
