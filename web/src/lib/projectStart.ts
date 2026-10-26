import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { isAutoScatterName } from '@/store/projectActions';
import { saveAsset } from '@/opfs/assetsIO';
import { newId } from './ids';
import { createChatNode, chatFallbackTitle, chatInitialBodyHeight, CHAT_NODE_WIDTH } from './chat/model';
import { submitChat } from './chat/actions';
import { classifyFile } from './mediaDetect';
import { fitMediaToWidth } from './mediaSizing';
import type { MediaRef, ScatterNode } from '@/store/types';

export interface ProjectStartImage {
  title: string;
  previewUrl: string;
  media: MediaRef;
  file?: File;
}

/** Validate before creating a project. Image URLs need not have an extension. */
export async function prepareProjectImage(input: File | string, signal: AbortSignal): Promise<ProjectStartImage> {
  const file = typeof input === 'string' ? undefined : input;
  if (file && classifyFile(file).kind !== 'image') throw new Error('Choose an image file (JPG, PNG, GIF, WebP, AVIF, or SVG).');
  let url: string;
  let title: string;
  if (file) {
    url = URL.createObjectURL(file);
    title = file.name.replace(/\.[^.]+$/, '').trim() || 'Image';
  } else {
    let parsed: URL;
    try { parsed = new URL((input as string).trim()); }
    catch { throw new Error('Enter a valid image link.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an http or https image link.');
    url = parsed.href;
    const name = parsed.pathname.split('/').filter(Boolean).at(-1);
    try { title = name ? decodeURIComponent(name).replace(/\.[^.]+$/, '') : parsed.hostname; }
    catch { title = parsed.hostname; }
  }
  try {
    const dimensions = await new Promise<{ naturalWidth: number; naturalHeight: number }>((resolve, reject) => {
      const img = new Image();
      const cleanup = () => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        img.onload = null; img.onerror = null;
      };
      const fail = (error: Error) => { cleanup(); img.src = ''; reject(error); };
      const abort = () => fail(new DOMException('Cancelled', 'AbortError'));
      const timer = setTimeout(() => fail(new Error('The image took too long to load. Try uploading it instead.')), 15_000);
      img.onload = () => { cleanup(); resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }); };
      img.onerror = () => fail(new Error('Could not load this image. Use a direct image link or upload the file.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      img.src = url;
    });
    return { title: title || 'Image', previewUrl: url, file,
      media: file ? { source: 'asset', kind: 'image', fileName: file.name, mime: file.type, byteSize: file.size, ...dimensions }
        : { source: 'link', kind: 'image', url, ...dimensions } };
  } catch (error) {
    if (file) URL.revokeObjectURL(url);
    throw error;
  }
}

function rootPosition(width: number) {
  return { x: (typeof window === 'undefined' ? 800 : window.innerWidth) / 2 / 0.75 - width / 2,
    y: (60 + ((typeof window === 'undefined' ? 600 : window.innerHeight) - 60) * 0.25) / 0.75 };
}

/** Root content, name, and root identity form one undoable content action.
 * Project creation/switching and camera/selection remain navigation. */
function installRoot(node: ScatterNode, title: string, projectId: string) {
  const graph = useGraphStore.getState();
  const project = graph.project;
  if (!project || project.id !== projectId || Object.keys(project.nodes).length) {
    throw new Error('The project changed. Open the picker and try again.');
  }
  const name = isAutoScatterName(project.name) ? title : project.name;
  const viewport = { x: 0, y: 0, zoom: 0.75 };
  graph.setProject({ ...project, name, rootNodeId: node.id, nodes: { [node.id]: { ...node, frozen: true } },
    selection: [node.id], viewport, updatedAt: Date.now() });
  graph.setProjectList(graph.projectList.map((item) => item.id === projectId ? { ...item, name } : item));
}

export function startChatRoot(question: string, options: { skipPendingSources: boolean }): string {
  const project = useGraphStore.getState().project;
  if (!project) throw new Error('No project is open.');
  const node = createChatNode({ id: newId(), createdAt: Date.now(), position: rootPosition(CHAT_NODE_WIDTH),
    informationChunking: useSettingsStore.getState().defaultChatInformationChunking,
    bodyHeight: chatInitialBodyHeight(typeof window === 'undefined' ? 900 : window.innerHeight) });
  installRoot(node, chatFallbackTitle(question), project.id);
  // Keep the prompt in the composer if model availability prevents sending.
  useChatRuntimeStore.getState().setDraft(project.id, node.id, { text: question });
  void submitChat(node.id, { question, ...options });
  useGraphStore.getState().requestPanTo(node.id, undefined, 'rootGeneration');
  return node.id;
}

export async function startImageRoot(image: ProjectStartImage): Promise<string> {
  const project = useGraphStore.getState().project;
  if (!project) throw new Error('No project is open.');
  const media = { ...image.media };
  if (image.file) {
    media.assetId = newId();
    await saveAsset(project.id, media.assetId, image.file);
  }
  const size = fitMediaToWidth(media.naturalWidth!, media.naturalHeight!);
  const node: ScatterNode = { id: newId(), type: 'media', position: rootPosition(size.width), frozen: true,
    currentVersionIndex: 0,
    versions: [{ header: image.title, body: '', media, contentType: 'media', generatedBy: 'media', createdAt: Date.now(), ...size }] };
  installRoot(node, image.title, project.id);
  return node.id;
}
