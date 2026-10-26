import { describe, expect, it } from 'vitest';
import { stageLabel } from './SourceManager';

describe('SourceManager stage labels', () => {
  it('shows passage-level semantic indexing progress', () => {
    expect(stageLabel({
      status: 'indexing',
      indexingCompleted: 16,
      indexingTotal: 43,
    })).toBe('Semantic indexing 16 / 43');
  });

  it('describes indexing before a passage total is available', () => {
    expect(stageLabel({ status: 'indexing' })).toBe('Preparing semantic index');
  });
});
