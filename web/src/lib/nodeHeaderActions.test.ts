import { beforeEach, describe, expect, it } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { canInlineEditNodeHeader } from './nodeHeaderText';
import { requestNodeHeaderEdit, saveNodeHeader } from './nodeHeaderActions';
import type { ScatterNode } from '@/store/types';

beforeEach(() => {
  useGraphStore.temporal.getState().pause();
  const project = createBlankProject('Headers', 'root');
  project.nodes.root = { id: 'root', type: 'media', position: { x: 0, y: 0 }, frozen: true, currentVersionIndex: 0,
    versions: [{ header: 'Image', body: '', createdAt: 1, generatedBy: 'media', contentType: 'media', language: 'ja',
      media: { source: 'asset', kind: 'image', assetId: 'pixels' } }] };
  useGraphStore.setState({ project });
  useGraphStore.temporal.getState().clear();
  useGraphStore.temporal.getState().resume();
  useChatRuntimeStore.setState({ views: {} });
});
describe('inline node header actions', () => {
  it('is one undoable edit and retains image identity, language and versions', () => {
    const project = useGraphStore.getState().project!;
    const original = project.nodes.root!;
    requestNodeHeaderEdit('root');
    expect(useChatRuntimeStore.getState().views.root?.titleEditNonce).toBe(1);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    saveNodeHeader(project.id, 'root', 1, '日本語のタイトル');
    const node = useGraphStore.getState().project!.nodes.root!;
    expect(node.versions).toHaveLength(1);
    expect(node.versions[0]).toMatchObject({ header: '日本語のタイトル', language: 'ja', media: original.versions[0]!.media });
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.nodes.root!.versions).toEqual(original.versions);
  });
  it('targets the original version and never another project with the same node id', () => {
    const project = useGraphStore.getState().project!;
    const node = project.nodes.root!;
    useGraphStore.getState().updateNode('root', { versions: [...node.versions, { ...node.versions[0]!, createdAt: 2, header: 'Newer' }], currentVersionIndex: 1 });
    saveNodeHeader(project.id, 'root', 1, 'Earlier edited');
    expect(useGraphStore.getState().project!.nodes.root!.versions.map(v => v.header)).toEqual(['Earlier edited', 'Newer']);
    saveNodeHeader('other-project', 'root', 2, 'Wrong project');
    expect(useGraphStore.getState().project!.nodes.root!.versions[1]!.header).toBe('Newer');
  });
  it('allows simple titles and a media prefix, not multi-part question or suffix headers', () => {
    const original = useGraphStore.getState().project!.nodes.root!;
    const withParts = (parts: { subject: string; prefix?: string; question?: string; suffix?: string }): ScatterNode => ({
      ...original, versions: [{ ...original.versions[0]!, headerParts: parts }],
    });
    expect(canInlineEditNodeHeader(withParts({ subject: 'Simple' }), {})).toBe(true);
    expect(canInlineEditNodeHeader(withParts({ prefix: 'Image', subject: 'Prompt' }), {})).toBe(true);
    expect(canInlineEditNodeHeader(withParts({ subject: 'Topic', suffix: 'explained' }), {})).toBe(false);
    expect(canInlineEditNodeHeader(withParts({ subject: 'Selected text', question: 'What is this?' }), {})).toBe(false);
  });
});
