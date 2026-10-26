import { afterEach, describe, expect, it } from 'vitest';
import {
  beginGenerationSession,
  cancelGenerationSession,
  finishGenerationSession,
  getGenerationSession,
  markGenerationTextReceived,
  registerGenerationController,
  resetGenerationSessionsForTests,
} from './generationSession';

afterEach(() => resetGenerationSessionsForTests());

describe('generation sessions', () => {
  it('aborts every registered pass and removes the canceled session', () => {
    const session = beginGenerationSession({
      projectId: 'p0', nodeId: 'n0', kind: 'rewrite',
      sourceVersionIndex: 0, draftVersionIndex: 1,
    });
    const text = new AbortController();
    const chips = new AbortController();
    registerGenerationController(session.id, text);
    registerGenerationController(session.id, chips);
    markGenerationTextReceived(session.id);

    const canceled = cancelGenerationSession('p0', 'n0');

    expect(text.signal.aborted).toBe(true);
    expect(chips.signal.aborted).toBe(true);
    expect(canceled).toEqual(expect.objectContaining({
      id: session.id,
      modelTextReceived: true,
      sourceVersionIndex: 0,
      draftVersionIndex: 1,
    }));
    expect(getGenerationSession('p0', 'n0')).toBeUndefined();
  });

  it('does not let stale completion remove a replacement session', () => {
    const oldSession = beginGenerationSession({
      projectId: 'p0', nodeId: 'n0', kind: 'rewrite',
      sourceVersionIndex: 0, draftVersionIndex: 1,
    });
    const replacement = beginGenerationSession({
      projectId: 'p0', nodeId: 'n0', kind: 'rewrite',
      sourceVersionIndex: 0, draftVersionIndex: 1,
    });

    finishGenerationSession('p0', 'n0', oldSession.id);

    expect(getGenerationSession('p0', 'n0')?.id).toBe(replacement.id);
  });
});
