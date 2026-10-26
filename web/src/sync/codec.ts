import type {
  ParsedSnapshotName,
  ProjectSnapshotEnvelope,
  ProjectViewEnvelope,
  RemoteObject,
  SyncSnapshotEnvelope,
} from './types';
import { SYNC_FORMAT, SYNC_FORMAT_VERSION } from './types';

const PREFIX = 'scatter-v1';

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

export async function sha256Hex(value: Blob | string): Promise<string> {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : new Uint8Array(await value.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function projectSnapshotName(snapshot: ProjectSnapshotEnvelope): string {
  return [
    PREFIX,
    'project',
    base64Url(snapshot.projectId),
    String(snapshot.editedAt),
    String(snapshot.sequence),
    base64Url(snapshot.deviceId),
    snapshot.deleted ? '1' : '0',
    snapshot.hash.slice(0, 24),
    'json.gz',
  ].join('.');
}

export function preferencesSnapshotName(
  editedAt: number,
  sequence: number,
  deviceId: string,
  hash: string,
): string {
  return [
    PREFIX,
    'preferences',
    String(editedAt),
    String(sequence),
    base64Url(deviceId),
    hash.slice(0, 24),
    'json.gz',
  ].join('.');
}

export function assetObjectName(projectId: string, assetId: string): string {
  return [PREFIX, 'asset', base64Url(projectId), base64Url(assetId), 'bin'].join('.');
}

export function projectViewName(view: ProjectViewEnvelope): string {
  return [PREFIX, 'view', base64Url(view.projectId), String(view.editedAt),
    String(view.sequence), base64Url(view.deviceId), 'json.gz'].join('.');
}

export function parseSnapshotName(name: string): ParsedSnapshotName | null {
  const parts = name.split('.');
  if (parts[0] !== PREFIX) return null;
  if (parts[1] === 'view' && parts.length === 8) {
    const projectId = fromBase64Url(parts[2]!);
    const deviceId = fromBase64Url(parts[5]!);
    const editedAt = Number(parts[3]);
    const sequence = Number(parts[4]);
    if (!projectId || !deviceId || !Number.isFinite(editedAt) || editedAt < 0 || !Number.isFinite(sequence)) return null;
    return { kind: 'view', projectId, deviceId, editedAt, sequence };
  }
  if (parts[1] === 'asset' && parts.length === 5) {
    const projectId = parts[2] ? fromBase64Url(parts[2]) : null;
    const assetId = parts[3] ? fromBase64Url(parts[3]) : null;
    return projectId && assetId ? { kind: 'asset', projectId, assetId } : null;
  }
  if (parts[1] === 'project' && parts.length === 10) {
    const projectId = parts[2] ? fromBase64Url(parts[2]) : null;
    const deviceId = parts[5] ? fromBase64Url(parts[5]) : null;
    const editedAt = Number(parts[3]);
    const sequence = Number(parts[4]);
    if (!projectId || !deviceId || !Number.isFinite(editedAt) || !Number.isFinite(sequence)) return null;
    return {
      kind: 'project', projectId, deviceId, editedAt, sequence,
      deleted: parts[6] === '1', hash: parts[7],
    };
  }
  if (parts[1] === 'preferences' && parts.length === 8) {
    const editedAt = Number(parts[2]);
    const sequence = Number(parts[3]);
    const deviceId = parts[4] ? fromBase64Url(parts[4]) : null;
    if (!deviceId || !Number.isFinite(editedAt) || !Number.isFinite(sequence)) return null;
    return { kind: 'preferences', editedAt, sequence, deviceId, hash: parts[5] };
  }
  return null;
}

export function compareSnapshotObjects(a: RemoteObject, b: RemoteObject): number {
  const pa = parseSnapshotName(a.name);
  const pb = parseSnapshotName(b.name);
  if (!pa || !pb) return a.name.localeCompare(b.name);
  const time = (pa.editedAt ?? 0) - (pb.editedAt ?? 0);
  if (time !== 0) return time;
  const sequence = (pa.sequence ?? 0) - (pb.sequence ?? 0);
  if (sequence !== 0) return sequence;
  return (pa.deviceId ?? '').localeCompare(pb.deviceId ?? '');
}

async function gzip(text: string): Promise<Blob> {
  const sourceBlob = new Blob([text]);
  if (typeof CompressionStream === 'undefined' || typeof sourceBlob.stream !== 'function') {
    return new Blob([text], { type: 'application/json' });
  }
  const source = sourceBlob.stream();
  const compressed = source.pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(compressed).arrayBuffer()], { type: 'application/gzip' });
}

async function ungzip(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return blob.text();
  if (typeof DecompressionStream === 'undefined' || typeof blob.stream !== 'function') {
    throw new Error('This browser cannot read compressed sync data.');
  }
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function isSyncEnvelope(value: unknown): value is SyncSnapshotEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<SyncSnapshotEnvelope>;
  return envelope.format === SYNC_FORMAT
    && envelope.formatVersion === SYNC_FORMAT_VERSION
    && (envelope.kind === 'project' || envelope.kind === 'preferences'
      || (envelope.kind === 'view' && typeof envelope.projectId === 'string'
        && typeof envelope.deviceId === 'string' && Number.isFinite(envelope.sequence)
        && Number.isFinite(envelope.editedAt) && envelope.editedAt! >= 0
        && !!envelope.viewport && Number.isFinite(envelope.viewport.x)
        && Number.isFinite(envelope.viewport.y) && Number.isFinite(envelope.viewport.zoom)
        && envelope.viewport.zoom > 0));
}

export async function encodeEnvelope(envelope: SyncSnapshotEnvelope): Promise<Blob> {
  return gzip(JSON.stringify(envelope));
}

export async function decodeEnvelope(blob: Blob): Promise<SyncSnapshotEnvelope> {
  const parsed = JSON.parse(await ungzip(blob)) as unknown;
  if (!isSyncEnvelope(parsed)) throw new Error('The synchronized snapshot is damaged or unsupported.');
  return parsed;
}
