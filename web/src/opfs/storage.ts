async function root(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory();
}

async function resolve(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error(`Invalid path: ${path}`);
  let dir = await root();
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return { dir, name };
}

export async function readJSON<T = unknown>(path: string, options?: { allowEmpty?: boolean }): Promise<T | null> {
  try {
    const { dir, name } = await resolve(path, false);
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    const text = await file.text();
    // A newly created sync metadata file can be empty if its first write was
    // interrupted by navigation. Only explicitly opted-in metadata may reset.
    if (options?.allowEmpty && !text.trim()) return null;
    return JSON.parse(text) as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return null;
    throw e;
  }
}

export async function writeJSON(path: string, data: unknown): Promise<void> {
  const { dir, name } = await resolve(path, true);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(data));
  await writable.close();
}

/** Delete a file at the given path. A missing file (or missing parent dir) is
 *  treated as already-deleted (no throw). */
export async function deleteFile(path: string): Promise<void> {
  try {
    const { dir, name } = await resolve(path, false);
    await dir.removeEntry(name);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return;
    throw e;
  }
}

/** Write raw binary (an image/video Blob) to the given path. Mirror of
 *  writeJSON but for bytes — used for media assets, which must NOT live in the
 *  project JSON. */
export async function writeBlob(path: string, blob: Blob): Promise<void> {
  const { dir, name } = await resolve(path, true);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/** Read raw binary from the given path, or null if it doesn't exist. The
 *  returned File extends Blob (URL.createObjectURL-able). */
export async function readBlob(path: string): Promise<Blob | null> {
  try {
    const { dir, name } = await resolve(path, false);
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return null;
    throw e;
  }
}

/** List the entry names directly inside a directory. A missing directory
 *  yields an empty list (no throw). */
export async function listDir(path: string): Promise<string[]> {
  try {
    const { dir, name } = await resolve(path, false);
    const handle = await dir.getDirectoryHandle(name);
    const out: string[] = [];
    const iter = handle as unknown as { keys: () => AsyncIterableIterator<string> };
    for await (const key of iter.keys()) out.push(key);
    return out;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return [];
    throw e;
  }
}

/** Recursively remove a directory and everything under it. A missing directory
 *  is treated as already-removed (no throw). */
export async function removeDir(path: string): Promise<void> {
  try {
    const { dir, name } = await resolve(path, false);
    await dir.removeEntry(name, { recursive: true });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return;
    throw e;
  }
}
