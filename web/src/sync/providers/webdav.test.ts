import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebDavSyncProvider } from './webdav';

const connection = {
  baseUrl: 'https://cloud.example.test/remote.php/dav/files/me/',
  username: 'me',
  appPassword: 'app-password',
  folder: 'Scatter Sync',
};

const fileName = 'scatter-v1.asset.cA.YQ.bin';
const responseEntry = (name = fileName) => `<d:response><d:href>/dav/${name}</d:href><d:propstat><d:prop><d:getetag>"version"</d:getetag><d:getcontentlength>12</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const report = (entries: string, token = 'token-1') => new Response(`<d:multistatus xmlns:d="DAV:">${entries}<d:sync-token>${token}</d:sync-token></d:multistatus>`, { status: 207 });

afterEach(() => vi.restoreAllMocks());

describe('WebDAV synchronization provider', () => {
  it('creates a missing private folder and verifies list access', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 201 }))
      .mockResolvedValueOnce(new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>', { status: 207 }));
    await new WebDavSyncProvider(connection).test();
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['PROPFIND', 'MKCOL', 'PROPFIND']);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) });
  });

  it('uses content-addressed create-only writes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 207 }))
      .mockResolvedValueOnce(new Response('', { status: 201, headers: { etag: '"abc"' } }));
    const provider = new WebDavSyncProvider(connection);
    await provider.write('scatter-v1.asset.cA.YQ.bin', new Blob(['bytes']));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      headers: expect.objectContaining({ 'If-None-Match': '*' }),
    });
  });

  it('rejects insecure non-local servers', () => {
    expect(() => new WebDavSyncProvider({ ...connection, baseUrl: 'http://cloud.example.test/dav/' }))
      .toThrow('requires HTTPS');
  });

  it('uses initial and incremental collection reports with canonical file IDs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 207 }))
      .mockResolvedValueOnce(report(responseEntry()))
      .mockResolvedValueOnce(report(`<d:response><d:href>/dav/${fileName}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`, 'token-2'));
    const source = new WebDavSyncProvider(connection);
    const first = await source.changes();
    expect(first).toMatchObject({ reset: true, cursor: 'token-1', objects: [{ name: fileName, etag: 'version', size: 12 }] });
    const next = await source.changes(first.cursor);
    expect(next).toEqual({ reset: false, cursor: 'token-2', objects: [], removedIds: [first.objects[0]!.id] });
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['PROPFIND', 'REPORT', 'REPORT']);
  });

  it('follows partial reports, escapes tokens, and preserves changes across pages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(report(`${responseEntry()}<d:response><d:href>/dav/</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>`, 'page-2'))
      .mockResolvedValueOnce(report(responseEntry('scatter-v1.asset.cA.Yg.bin'), 'done'));
    const result = await new WebDavSyncProvider(connection).changes('token&<>');
    expect(result.objects).toHaveLength(2);
    expect(result.cursor).toBe('done');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('token&amp;&lt;&gt;');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain('page-2');
  });

  it('rebuilds when a server has expired its change history', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<d:valid-sync-token xmlns:d="DAV:"/>', { status: 403 }))
      .mockResolvedValueOnce(new Response('', { status: 207 }))
      .mockResolvedValueOnce(report(responseEntry(), 'fresh'));
    expect(await new WebDavSyncProvider(connection).changes('old')).toMatchObject({ reset: true, cursor: 'fresh' });
  });

  it('recovers if the sync folder was deleted externally', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 201 }))
      .mockResolvedValueOnce(report('', 'new-folder'));
    expect(await new WebDavSyncProvider(connection).changes('old')).toEqual({ reset: true, cursor: 'new-folder', objects: [], removedIds: [] });
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['REPORT', 'PROPFIND', 'MKCOL', 'REPORT']);
  });

  it.each(['unsupported', 'cors'])('falls back to PROPFIND for %s REPORT requests', async (failure) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    if (failure === 'unsupported') fetchMock.mockResolvedValueOnce(new Response('', { status: 405 }));
    else fetchMock.mockRejectedValueOnce(new TypeError('CORS'));
    fetchMock.mockResolvedValueOnce(new Response('', { status: 207 }))
      .mockResolvedValueOnce(report(responseEntry()));
    const result = await new WebDavSyncProvider(connection).changes('previous');
    expect(result).toMatchObject({ reset: true, cursor: 'listing', objects: [{ name: fileName }] });
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['REPORT', 'PROPFIND', 'PROPFIND']);
  });

  it('rejects HTML and incomplete metadata instead of treating either as an empty collection', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html/>', { status: 200 }));
    await expect(new WebDavSyncProvider(connection).changes('old')).rejects.toThrow('invalid listing XML');
    fetchMock.mockResolvedValueOnce(report(`<d:response><d:href>/dav/${fileName}</d:href></d:response>`));
    await expect(new WebDavSyncProvider(connection).changes('old')).rejects.toThrow('could not read sync metadata');
  });
});
