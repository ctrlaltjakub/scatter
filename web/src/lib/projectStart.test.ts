import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { getChatDraft } from '@/store/useChatRuntimeStore';
import { submitChat } from './chat/actions';
import { saveAsset } from '@/opfs/assetsIO';
import { prepareProjectImage, startChatRoot, startImageRoot, type ProjectStartImage } from './projectStart';
import { describeHistoryChange } from './historySemantics';
import { CHAT_NODE_WIDTH, chatInitialBodyHeight } from './chat/model';

vi.mock('./chat/actions', () => ({ submitChat: vi.fn(async () => {}) }));
vi.mock('@/opfs/assetsIO', () => ({ saveAsset: vi.fn(async () => {}) }));

beforeEach(() => {
  vi.clearAllMocks();
  const project = createBlankProject('New project', '');
  project.sourceLibrary = { mode: 'use', order: [], sources: {} };
  useGraphStore.setState({ project, activeProjectId: project.id, projectList: [
    { id: project.id, name: project.name, createdAt: 1, updatedAt: 1 },
  ] });
  useGraphStore.temporal.getState().clear();
});
afterEach(() => vi.unstubAllGlobals());

const image = (): ProjectStartImage => ({ title: 'A diagram', previewUrl: 'https://example.com/image',
  media: { source: 'link', kind: 'image', url: 'https://example.com/image', naturalWidth: 800, naturalHeight: 600 } });

describe('starting projects with content', () => {
  it('creates a standalone root chat and passes the exact prompt and source choice to normal chat generation', () => {
    const before = useGraphStore.getState().project!;
    const id = startChatRoot('Tell me about: therapy', { skipPendingSources: true });
    const project = useGraphStore.getState().project!;
    expect(project.rootNodeId).toBe(id);
    expect(project.nodes[id]?.chat?.parentNodeId).toBeUndefined();
    expect(project.nodes[id]?.type).toBe('chat');
    expect(project.nodes[id]?.versions[0]).toMatchObject({ width: CHAT_NODE_WIDTH, bodyMaxHeight: chatInitialBodyHeight(window.innerHeight) });
    expect(project.nodes[id]?.frozen).toBe(true);
    expect(project.arrows).toEqual({});
    expect(project.name).toBe('Tell me about: therapy');
    expect(project.sourceLibrary).toEqual(before.sourceLibrary);
    expect(getChatDraft(project.id, id).text).toBe('Tell me about: therapy');
    expect(submitChat).toHaveBeenCalledWith(id, { question: 'Tell me about: therapy', skipPendingSources: true });
    expect(useGraphStore.getState().panTo).toMatchObject({ id, automatic: 'rootGeneration' });
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    expect(describeHistoryChange(before, project).kind).toBe('node-create');
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project?.nodes).toEqual({});
    useGraphStore.temporal.getState().redo();
    expect(useGraphStore.getState().project?.nodes[id]?.chat).toBeDefined();
    expect(useGraphStore.getState().project?.nodes[id]?.frozen).toBe(true);
  });

  it('installs a sized image root without AI and preserves source policy', async () => {
    const id = await startImageRoot(image());
    const project = useGraphStore.getState().project!;
    expect(project.nodes[id]?.versions[0]).toMatchObject({ contentType: 'media', media: image().media, header: 'A diagram' });
    expect(project.nodes[id]?.versions[0]?.width).toBeGreaterThan(0);
    expect(project.nodes[id]?.frozen).toBe(true);
    expect(project.sourceLibrary?.mode).toBe('use');
    expect(project.rootNodeId).toBe(id);
    expect(saveAsset).not.toHaveBeenCalled(); expect(submitChat).not.toHaveBeenCalled();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project?.nodes).toEqual({});
  });

  it('saves uploaded bytes before installing their reference', async () => {
    const file = new File(['pixels'], 'diagram.png', { type: 'image/png' });
    const prepared = { ...image(), file, media: { ...image().media, source: 'asset' as const, url: undefined } };
    const projectId = useGraphStore.getState().project!.id;
    const id = await startImageRoot(prepared);
    const media = useGraphStore.getState().project!.nodes[id]!.versions[0]!.media!;
    expect(saveAsset).toHaveBeenCalledWith(projectId, media.assetId, file);
  });

  it('does not overwrite content or a different project after an upload', async () => {
    const another = createBlankProject('Other project', '');
    vi.mocked(saveAsset).mockImplementationOnce(async () => { useGraphStore.setState({ project: another }); });
    await expect(startImageRoot({ ...image(), file: new File(['x'], 'x.png') })).rejects.toThrow('project changed');
    expect(useGraphStore.getState().project).toBe(another);
    startChatRoot('First', { skipPendingSources: false });
    await expect(startImageRoot(image())).rejects.toThrow('project changed');
    expect(Object.values(useGraphStore.getState().project!.nodes)[0]?.type).toBe('chat');
  });

  it('keeps user-chosen project names', async () => {
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, name: 'My chosen name' });
    await startImageRoot(image());
    expect(useGraphStore.getState().project?.name).toBe('My chosen name');
  });
});

describe('preparing image input', () => {
  const signal = () => new AbortController().signal;
  function mockImage(success: boolean) {
    vi.stubGlobal('Image', class {
      naturalWidth = 1200; naturalHeight = 800;
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(value: string) { if (value) queueMicrotask(() => success ? this.onload?.() : this.onerror?.()); }
    });
  }
  it('accepts direct links without extensions when they load as images', async () => {
    mockImage(true);
    const result = await prepareProjectImage('https://example.com/diagram?size=large', signal());
    expect(result.media).toMatchObject({ source: 'link', kind: 'image', naturalWidth: 1200, naturalHeight: 800 });
    expect(result.title).toBe('diagram');
  });
  it('rejects invalid schemes, videos, and unreadable links before project creation', async () => {
    await expect(prepareProjectImage('javascript:alert(1)', signal())).rejects.toThrow('http');
    await expect(prepareProjectImage(new File(['video'], 'movie.mp4', { type: 'video/mp4' }), signal())).rejects.toThrow('image file');
    mockImage(false);
    await expect(prepareProjectImage('https://example.com/not-image', signal())).rejects.toThrow('Could not load');
    expect(useGraphStore.getState().project?.nodes).toEqual({});
  });
  it('revokes previews for unreadable uploaded files', async () => {
    mockImage(false);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await expect(prepareProjectImage(new File(['bad'], 'image.png', { type: 'image/png' }), signal())).rejects.toThrow();
    expect(revoke).toHaveBeenCalled();
    revoke.mockRestore();
  });
  it('cancels a pending image load', async () => {
    vi.stubGlobal('Image', class { set src(_value: string) {} });
    const controller = new AbortController();
    const pending = prepareProjectImage('https://example.com/slow.png', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
