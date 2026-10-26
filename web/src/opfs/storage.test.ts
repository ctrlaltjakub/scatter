import { describe, it, expect, beforeEach } from 'vitest';
import { readJSON, writeJSON } from './storage';
import { loadSyncConfig, loadSyncLedger } from '@/sync/local';

class MockFile {
  contents = '';
  async write(s: string) { this.contents = s; }
  async getFile() { return { text: async () => this.contents }; }
  async createWritable() {
    return {
      write: async (s: string) => { this.contents = s; },
      close: async () => {},
    };
  }
}
class MockDir {
  files = new Map<string, MockFile>();
  dirs = new Map<string, MockDir>();
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException('NotFound', 'NotFoundError');
      this.files.set(name, new MockFile());
    }
    return this.files.get(name)!;
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    if (!this.dirs.has(name)) {
      if (!opts?.create) throw new DOMException('NotFound', 'NotFoundError');
      this.dirs.set(name, new MockDir());
    }
    return this.dirs.get(name)!;
  }
}

beforeEach(() => {
  const root = new MockDir();
  // @ts-expect-error mocking
  globalThis.navigator = { storage: { getDirectory: async () => root } };
});

describe('storage', () => {
  it('reads back what it wrote', async () => {
    await writeJSON('test.json', { hello: 'world' });
    expect(await readJSON('test.json')).toEqual({ hello: 'world' });
  });
  it('returns null when file missing', async () => {
    expect(await readJSON('missing.json')).toBeNull();
  });
  it('writes nested paths, creating directories', async () => {
    await writeJSON('a/b/c.json', { n: 1 });
    expect(await readJSON('a/b/c.json')).toEqual({ n: 1 });
  });
  it('recovers an empty first sync write interrupted by reload', async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('sync', { create: true });
    await dir.getFileHandle('ledger.json', { create: true });
    await dir.getFileHandle('config.json', { create: true });
    // This is the exact failure from the old unconditional metadata parse.
    await expect(readJSON('sync/ledger.json')).rejects.toThrow('Unexpected end of JSON input');
    await expect(loadSyncLedger()).resolves.toMatchObject({ projects: {}, knownProjectIds: [] });
    await expect(loadSyncConfig()).resolves.toMatchObject({ enabled: false, provider: null });
  });
  it('does not silently discard nonempty corrupt sync metadata', async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('sync', { create: true });
    const file = await dir.getFileHandle('ledger.json', { create: true });
    const writer = await file.createWritable();
    await writer.write('{"projects":');
    await writer.close();
    await expect(loadSyncLedger()).rejects.toThrow();
  });
});
