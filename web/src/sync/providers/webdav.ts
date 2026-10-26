import { sha256Hex } from '../codec';
import { SyncNamespace } from '../namespace';
import { isSyncTimeout, syncFailureMessage, syncRequestSignal } from '../requestTimeout';
import type { RemoteChanges, RemoteObject, SyncProvider, WebDavConnection } from '../types';

const DAV_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>`;

function normalizedRoot(connection: WebDavConnection): URL {
  const base = new URL(connection.baseUrl);
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
    throw new Error('WebDAV sync requires HTTPS.');
  }
  const folder = connection.folder.trim() || 'Scatter Sync';
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  base.pathname = `${basePath}${encodeURIComponent(folder)}/`;
  return base;
}
function basicAuth(connection: WebDavConnection): string {
  const raw = `${connection.username}:${connection.appPassword}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function request(
  connection: WebDavConnection,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: syncRequestSignal(init, init.method === 'GET'),
      headers: {
        Authorization: basicAuth(connection),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (isSyncTimeout(error)) {
      throw new Error(syncFailureMessage(error));
    }
    throw new Error(
      `Could not reach WebDAV. Check its address and allow Scatter through CORS. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }
  return response;
}

async function ensureRoot(connection: WebDavConnection, root: URL): Promise<void> {
  const probe = await request(connection, root, { method: 'PROPFIND', headers: { Depth: '0' } });
  if (probe.ok || probe.status === 207) return;
  if (probe.status !== 404) throw new Error(`WebDAV connection failed (${probe.status}).`);
  const created = await request(connection, root, { method: 'MKCOL' });
  if (!created.ok && created.status !== 405) {
    throw new Error(`Scatter could not create its WebDAV folder (${created.status}).`);
  }
}

function childUrl(root: URL, name: string): URL {
  return new URL(encodeURIComponent(name), root);
}

function parseListing(text: string, root: URL, namespace: SyncNamespace) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length
    || xml.documentElement.namespaceURI !== 'DAV:' || xml.documentElement.localName !== 'multistatus') {
    throw new Error('WebDAV returned invalid listing XML.');
  }
  const objects: RemoteObject[] = [];
  const removedIds: string[] = [];
  let more = false;
  for (const item of Array.from(xml.getElementsByTagNameNS('DAV:', 'response'))) {
    const status = Array.from(item.children).find((child) => child.localName === 'status')?.textContent ?? '';
    if (/\s507\s/.test(status)) { more = true; continue; }
    const href = item.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
    const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop() ?? '');
    if (!name.startsWith(namespace.prefix)) continue;
    const id = childUrl(root, name).href;
    if (/\s404\s/.test(status)) { removedIds.push(id); continue; }
    if (status && !/\s200\s/.test(status)) throw new Error(`WebDAV could not read sync metadata (${status}).`);
    const props = Array.from(item.getElementsByTagNameNS('DAV:', 'propstat'))
      .filter((stat) => /\s200\s/.test(stat.getElementsByTagNameNS('DAV:', 'status')[0]?.textContent ?? ''));
    if (!props.length) throw new Error(`WebDAV could not read sync metadata for ${name}.`);
    const property = (key: string) => props.map((stat) => stat.getElementsByTagNameNS('DAV:', key)[0]?.textContent)
      .find((value) => value != null);
    const etag = property('getetag')?.replace(/^"|"$/g, '');
    const modified = property('getlastmodified');
    const size = Number(property('getcontentlength'));
    objects.push(namespace.localObject({
      id, name,
      ...(etag ? { etag } : {}),
      ...(modified && Number.isFinite(Date.parse(modified)) ? { modifiedAt: Date.parse(modified) } : {}),
      ...(Number.isFinite(size) ? { size } : {}),
    }));
  }
  const cursor = Array.from(xml.documentElement.children)
    .find((child) => child.namespaceURI === 'DAV:' && child.localName === 'sync-token')?.textContent ?? '';
  return { objects, removedIds, more, cursor };
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export class WebDavSyncProvider implements SyncProvider {
  readonly kind = 'webdav' as const;
  private readonly namespace = new SyncNamespace();
  private readonly root: URL;

  constructor(private readonly connection: WebDavConnection) {
    this.root = normalizedRoot(connection);
  }

  async indexScope(): Promise<string> {
    return `webdav:${await sha256Hex(`${this.root.href}\n${this.connection.username}`)}${this.namespace.scopeSuffix}`;
  }

  async changes(cursor?: string): Promise<RemoteChanges> {
    const fullListing = async (): Promise<RemoteChanges> => ({
      reset: true, objects: await this.list(), removedIds: [], cursor: 'listing',
    });
    if (cursor === 'listing') return fullListing();
    if (!cursor) await ensureRoot(this.connection, this.root);
    const objects = new Map<string, RemoteObject>();
    const removedIds = new Set<string>();
    const visited = new Set<string>();
    let token = cursor ?? '';
    while (true) {
      if (visited.has(token)) throw new Error('WebDAV repeated a change page.');
      visited.add(token);
      let response: Response;
      try {
        response = await request(this.connection, this.root, {
          method: 'REPORT',
          headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
          body: `<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${xmlEscape(token)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/><d:getlastmodified/><d:getcontentlength/></d:prop></d:sync-collection>`,
        });
      } catch {
        // Some otherwise compatible servers omit REPORT from their CORS
        // allow-list. The established PROPFIND path remains usable there.
        return fullListing();
      }
      const text = await response.text();
      // The sync folder can have been removed/recreated outside Scatter.
      // Recreate and establish a complete baseline, as full-list sync did.
      if (response.status === 404 && cursor) return this.changes();
      if (response.status === 403 && /valid-sync-token/.test(text) && cursor) return this.changes();
      if ([405, 501].includes(response.status) || (response.status === 403 && /supported-report/.test(text))) return fullListing();
      if (!response.ok && response.status !== 207) throw new Error(`WebDAV change listing failed (${response.status}).`);
      const page = parseListing(text, this.root, this.namespace);
      if (!page.cursor) return fullListing();
      for (const id of page.removedIds) { objects.delete(id); removedIds.add(id); }
      for (const object of page.objects) { removedIds.delete(object.id); objects.set(object.id, object); }
      token = page.cursor;
      if (!page.more) return { reset: !cursor, objects: [...objects.values()], removedIds: [...removedIds], cursor: token };
    }
  }

  async test(): Promise<void> {
    await ensureRoot(this.connection, this.root);
    const response = await request(this.connection, this.root, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: DAV_BODY,
    });
    if (!response.ok && response.status !== 207) {
      throw new Error(`WebDAV list access failed (${response.status}).`);
    }
  }

  async list(): Promise<RemoteObject[]> {
    await ensureRoot(this.connection, this.root);
    const response = await request(this.connection, this.root, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: DAV_BODY,
    });
    if (!response.ok && response.status !== 207) {
      throw new Error(`WebDAV list failed (${response.status}).`);
    }
    const listing = parseListing(await response.text(), this.root, this.namespace);
    if (listing.more) throw new Error('WebDAV returned an incomplete full listing.');
    return listing.objects;
  }

  async read(object: RemoteObject): Promise<Blob> {
    this.namespace.assertObject(object);
    const response = await request(this.connection, childUrl(this.root, this.namespace.remoteName(object.name)), { method: 'GET' });
    if (!response.ok) throw new Error(`WebDAV download failed (${response.status}).`);
    return response.blob();
  }

  async write(name: string, data: Blob): Promise<RemoteObject> {
    const remoteName = this.namespace.remoteName(name);
    await ensureRoot(this.connection, this.root);
    const response = await request(this.connection, childUrl(this.root, remoteName), {
      method: 'PUT',
      headers: { 'Content-Type': data.type || 'application/octet-stream', 'If-None-Match': '*' },
      body: data,
    });
    // The object names are content-addressed; an existing object is success.
    if (!response.ok && response.status !== 412) {
      throw new Error(`WebDAV upload failed (${response.status}).`);
    }
    return this.namespace.localObject({
      id: childUrl(this.root, remoteName).href,
      name: remoteName,
      size: data.size,
      etag: response.headers.get('etag')?.replace(/^"|"$/g, ''),
      modifiedAt: Date.now(),
    });
  }

  async remove(object: RemoteObject): Promise<void> {
    this.namespace.assertObject(object);
    const response = await request(this.connection, childUrl(this.root, this.namespace.remoteName(object.name)), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`WebDAV delete failed (${response.status}).`);
    }
  }
}
