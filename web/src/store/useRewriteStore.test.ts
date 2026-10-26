import { beforeEach, describe, expect, test } from 'vitest';
import {
  getActiveRecords,
  getDisplayBody,
  hasAnyActive,
  isPartialActiveOn,
  isWholeActive,
  targetsEqual,
  useRewriteStore,
} from './useRewriteStore';
import { endMarker, nextMarkerId, startMarker } from '@/lib/rewriteMarkers';

const NODE = 'node-x';

function reset() {
  useRewriteStore.setState({
    activeByNode: {},
    workingBody: {},
    snapshot: {},
    pendingSnapDown: {},
  });
}

describe('useRewriteStore — predicates', () => {
  beforeEach(() => reset());

  test('predicates default to false / empty for an unknown node', () => {
    expect(hasAnyActive(NODE)).toBe(false);
    expect(isWholeActive(NODE)).toBe(false);
    expect(isPartialActiveOn(NODE, { kind: 'freetext' })).toBe(false);
    expect(getActiveRecords(NODE)).toEqual([]);
  });

  test('targetsEqual: same kind + same index', () => {
    expect(targetsEqual({ kind: 'freetext' }, { kind: 'freetext' })).toBe(true);
    expect(targetsEqual({ kind: 'bullet', index: 2 }, { kind: 'bullet', index: 2 })).toBe(true);
    expect(targetsEqual({ kind: 'bullet', index: 2 }, { kind: 'bullet', index: 3 })).toBe(false);
    expect(targetsEqual({ kind: 'freetext' }, { kind: 'bullet', index: 0 })).toBe(false);
  });

  test('addRecord + predicates: whole rewrite is detected', () => {
    useRewriteStore.getState().addRecord({
      id: nextMarkerId(),
      nodeId: NODE,
      kind: 'whole',
      abortController: new AbortController(),
    });
    expect(hasAnyActive(NODE)).toBe(true);
    expect(isWholeActive(NODE)).toBe(true);
    expect(isPartialActiveOn(NODE, { kind: 'freetext' })).toBe(false);
  });

  test('isPartialActiveOn: same target is blocked, different is allowed', () => {
    useRewriteStore.getState().addRecord({
      id: nextMarkerId(),
      nodeId: NODE,
      kind: 'partial',
      target: { kind: 'bullet', index: 1 },
      abortController: new AbortController(),
    });
    expect(isPartialActiveOn(NODE, { kind: 'bullet', index: 1 })).toBe(true);
    expect(isPartialActiveOn(NODE, { kind: 'bullet', index: 2 })).toBe(false);
    expect(isPartialActiveOn(NODE, { kind: 'freetext' })).toBe(false);
    expect(isWholeActive(NODE)).toBe(false);
  });

  test('removeRecord clears the entry; map key removed when list empties', () => {
    const id = nextMarkerId();
    useRewriteStore.getState().addRecord({
      id, nodeId: NODE, kind: 'whole',
      abortController: new AbortController(),
    });
    useRewriteStore.getState().removeRecord(NODE, id);
    expect(hasAnyActive(NODE)).toBe(false);
    expect(useRewriteStore.getState().activeByNode[NODE]).toBeUndefined();
  });
});

describe('useRewriteStore — working body display', () => {
  beforeEach(() => reset());

  test('getDisplayBody falls back to version body when no burst', () => {
    expect(getDisplayBody(NODE, 0, 'version-body')).toBe('version-body');
  });

  test('getDisplayBody strips markers from the working body during a burst', () => {
    const id = nextMarkerId();
    const wb = `pre${startMarker(id)}live${endMarker(id)}post`;
    useRewriteStore.getState().setWorkingBody(NODE, wb);
    useRewriteStore.getState().setSnapshot(NODE, {
      preBurstBody: 'original', preBurstVersionIndex: 0,
      draftVersionIndex: 1, generationSessionId: 1,
      preBurstBodyMaxHeight: 100, preBurstMinBodyHeight: 100,
      preBurstBodyHeightFloor: 100, preBurstFreeTextHeight: 60,
      preBurstHadBullets: true,
      preBurstWasAtMin: true,
    });
    expect(getDisplayBody(NODE, 1, 'version-body')).toBe('prelivepost');
    expect(getDisplayBody(NODE, 0, 'older-version-body')).toBe('older-version-body');
  });

  test('clearBurst removes activeByNode, workingBody, and snapshot for the node', () => {
    const id = nextMarkerId();
    useRewriteStore.getState().addRecord({
      id, nodeId: NODE, kind: 'whole',
      abortController: new AbortController(),
    });
    useRewriteStore.getState().setWorkingBody(NODE, 'wb');
    useRewriteStore.getState().setSnapshot(NODE, {
      preBurstBody: 'orig', preBurstVersionIndex: 0,
      draftVersionIndex: 1, generationSessionId: 1,
      preBurstBodyMaxHeight: 100, preBurstMinBodyHeight: 100,
      preBurstBodyHeightFloor: 100, preBurstFreeTextHeight: 60,
      preBurstHadBullets: true,
      preBurstWasAtMin: true,
    });
    useRewriteStore.getState().clearBurst(NODE);
    expect(useRewriteStore.getState().activeByNode[NODE]).toBeUndefined();
    expect(useRewriteStore.getState().workingBody[NODE]).toBeUndefined();
    expect(useRewriteStore.getState().snapshot[NODE]).toBeUndefined();
  });
});
