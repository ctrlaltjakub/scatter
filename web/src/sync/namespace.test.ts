import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncNamespace } from './namespace';
import { WebDavSyncProvider } from './providers/webdav';
import { GoogleDriveSyncProvider } from './providers/googleDrive';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); localStorage.clear(); });
const name = 'scatter-v1.asset.cA.YQ.bin';
const betaName = 'scatter-beta-v1.asset.cA.YQ.bin';

describe('release-channel cloud isolation', () => {
  it('does not change existing stable names and rejects foreign cached objects', () => {
    vi.stubEnv('NEXT_PUBLIC_RELEASE_CHANNEL', 'stable');
    const stable = new SyncNamespace();
    expect(stable.remoteName(name)).toBe(name);
    vi.stubEnv('NEXT_PUBLIC_RELEASE_CHANNEL', 'beta');
    const beta = new SyncNamespace();
    const mapped = beta.localObject({ id: 'beta-file', name: betaName });
    expect(mapped).toEqual({ id: 'beta-file', name, namespace: 'beta' });
    expect(() => beta.assertObject({ id: 'stable-file', name })).toThrow('separate');
    expect(() => stable.assertObject(mapped)).toThrow('separate');
    expect(() => beta.localObject({ id: 'stable-file', name })).toThrow('another release');
  });

  it('isolates WebDAV list, report, upload, read and delete with an imported stable connection', async () => {
    vi.stubEnv('NEXT_PUBLIC_RELEASE_CHANNEL', 'beta');
    const provider = new WebDavSyncProvider({ baseUrl: 'https://dav.example.test/', username: 'tester', appPassword: 'fake', folder: 'Scatter Sync' });
    const entries = [name, betaName].map(n => `<d:response><d:href>/${n}</d:href><d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('');
    const listing = `<d:multistatus xmlns:d="DAV:">${entries}<d:sync-token>cursor</d:sync-token></d:multistatus>`;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Response(init?.method === 'PROPFIND' || init?.method === 'REPORT' ? listing : '', { status: 200 }));
    const list = await provider.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name, namespace: 'beta' });
    expect((await provider.changes('previous')).objects).toEqual(list);
    const written = await provider.write(name, new Blob(['x']));
    await provider.read(written);
    await provider.remove(written);
    for (const [url, init] of fetcher.mock.calls.filter(([, init]) => ['PUT', 'GET', 'DELETE'].includes(init!.method!))) {
      expect(String(url), init?.method).toContain(betaName);
    }
    expect(await provider.indexScope()).toMatch(/:beta$/);
    await expect(provider.remove({ id: 'stable', name })).rejects.toThrow('separate');
  });

  it('isolates Google Drive listings, changes, uploads and destructive operations', async () => {
    vi.stubEnv('NEXT_PUBLIC_RELEASE_CHANNEL', 'beta');
    localStorage.setItem('scatter.google-drive-token.v1', JSON.stringify({ accessToken: 'synthetic-token', expiresAt: Date.now() + 3600000 }));
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ files: [{ id: 'stable', name }, { id: 'beta', name: betaName }] }))
      .mockResolvedValueOnce(Response.json({ changes: [{ fileId: 'stable', file: { id: 'stable', name } }, { fileId: 'beta', file: { id: 'beta', name: betaName } }], newStartPageToken: 'next' }))
      .mockResolvedValueOnce(Response.json({ id: 'uploaded', name: betaName }))
      .mockResolvedValueOnce(new Response('image'))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const provider = new GoogleDriveSyncProvider();
    expect(await provider.list()).toEqual([{ id: 'beta', name, namespace: 'beta' }]);
    expect(String(fetcher.mock.calls[0]![0])).toContain(encodeURIComponent('scatter-beta-v1.'));
    expect((await provider.changes('cursor')).objects).toEqual([{ id: 'beta', name, namespace: 'beta' }]);
    const written = await provider.write(name, new Blob(['x']));
    expect(await (fetcher.mock.calls[2]![1]!.body as Blob).text()).toContain(betaName);
    await provider.read(written);
    await provider.remove(written);
    expect(await provider.indexScope()).toMatch(/:beta$/);
    await expect(provider.remove({ id: 'stable', name })).rejects.toThrow('separate');
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});
