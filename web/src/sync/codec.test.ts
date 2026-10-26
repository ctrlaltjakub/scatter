import { describe, expect, it } from 'vitest';
import type { Project } from '@/store/types';
import type { ProjectSnapshotEnvelope, ProjectViewEnvelope } from './types';
import {
  assetObjectName,
  compareSnapshotObjects,
  decodeEnvelope,
  encodeEnvelope,
  parseSnapshotName,
  preferencesSnapshotName,
  projectSnapshotName,
  projectViewName,
  isSyncEnvelope,
} from './codec';
import { SYNC_FORMAT, SYNC_FORMAT_VERSION } from './types';

function project(id = 'project.with spaces/ü'): Project {
  return {
    id,
    name: 'A project',
    createdAt: 1,
    updatedAt: 2,
    rootNodeId: '',
    nodes: {},
    arrows: {},
    groups: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: [],
  };
}

function envelope(overrides: Partial<ProjectSnapshotEnvelope> = {}): ProjectSnapshotEnvelope {
  const value = project();
  return {
    format: SYNC_FORMAT,
    formatVersion: SYNC_FORMAT_VERSION,
    kind: 'project',
    projectId: value.id,
    editedAt: 100,
    sequence: 3,
    deviceId: 'device/a',
    deviceName: 'Laptop',
    hash: 'abcdef0123456789abcdef0123456789',
    deleted: false,
    assetIds: ['asset one'],
    project: value,
    ...overrides,
  };
}

describe('sync snapshot codec', () => {
  it('round-trips a small camera record and rejects non-finite/invalid zoom data', async () => {
    const view: ProjectViewEnvelope = { format: SYNC_FORMAT, formatVersion: SYNC_FORMAT_VERSION, kind: 'view',
      projectId: 'project/ü', deviceId: 'device/a', sequence: 2, editedAt: 400,
      viewport: { x: -100, y: 900, zoom: 0.1 } };
    expect(parseSnapshotName(projectViewName(view))).toEqual({ kind: 'view',
      projectId: view.projectId, deviceId: view.deviceId, sequence: 2, editedAt: 400 });
    expect(await decodeEnvelope(await encodeEnvelope(view))).toEqual(view);
    expect(isSyncEnvelope({ ...view, viewport: { ...view.viewport, zoom: 0 } })).toBe(false);
    expect(isSyncEnvelope({ ...view, viewport: { ...view.viewport, x: Infinity } })).toBe(false);
    expect(isSyncEnvelope({ ...view, viewport: null })).toBe(false);
  });
  it('round-trips unicode-safe project, preference, and asset names', () => {
    const value = envelope();
    expect(parseSnapshotName(projectSnapshotName(value))).toMatchObject({
      kind: 'project',
      projectId: value.projectId,
      deviceId: value.deviceId,
      editedAt: 100,
      sequence: 3,
      deleted: false,
      hash: value.hash.slice(0, 24),
    });
    expect(parseSnapshotName(preferencesSnapshotName(200, 4, 'device/a', value.hash)))
      .toMatchObject({ kind: 'preferences', editedAt: 200, sequence: 4, deviceId: 'device/a' });
    expect(parseSnapshotName(assetObjectName(value.projectId, 'asset one')))
      .toEqual({ kind: 'asset', projectId: value.projectId, assetId: 'asset one' });
  });

  it('encodes and decodes a complete envelope', async () => {
    const value = envelope();
    expect(await decodeEnvelope(await encodeEnvelope(value))).toEqual(value);
  });

  it('orders snapshots by edit time, sequence, then device', () => {
    const objects = [
      { id: 'b', name: projectSnapshotName(envelope({ editedAt: 101, sequence: 1, deviceId: 'b' })) },
      { id: 'a', name: projectSnapshotName(envelope({ editedAt: 100, sequence: 9, deviceId: 'a' })) },
      { id: 'c', name: projectSnapshotName(envelope({ editedAt: 101, sequence: 1, deviceId: 'c' })) },
    ].sort(compareSnapshotObjects);
    expect(objects.map((object) => object.id)).toEqual(['a', 'b', 'c']);
  });

  it('rejects unrelated and malformed names', () => {
    expect(parseSnapshotName('holiday.jpg')).toBeNull();
    expect(parseSnapshotName('scatter-v1.project.not-enough.parts')).toBeNull();
  });
});
