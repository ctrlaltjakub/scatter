import { describe, expect, it, vi } from 'vitest';
import { copyTableToNode, tableMarkdown } from './tableNode';
import { LANGUAGES } from '../languages';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { termPreviewFingerprint } from '../termPreviewCore';
import type { NodeVersion } from '@/store/types';
vi.mock('../generate', () => ({ spawnNearParent: () => ({ x: 900, y: 0 }) }));

describe('table-only Markdown copies', () => {
  it('preserves cells, alignment, escaped pipes, terms, code and referenced links without surrounding prose', () => {
    const body = 'Before\n\n| A | B |\n|:---|---:|\n| **[[term]]** \\| x | `code`<br>[Site][ref] |\n\nAfter\n\n[ref]: https://example.com "Reference"';
    expect(tableMarkdown(body, 0)).toBe('| A | B |\n| :--- | ---: |\n| **[[term]]** \\| x | `code`<br>[Site][ref] |\n\n[ref]: https://example.com "Reference"');
    expect(tableMarkdown(body, 1)).toBeNull();
    expect(tableMarkdown('```\n| Not | Table |\n|---|---|\n```', 0)).toBeNull();
  });
  it('extracts nested tables and selects the right table', () => {
    expect(tableMarkdown('> | A |\n> |---|\n> | Value |\n\n| Second |\n|---|\n| Other |', 0)).toBe('| A |\n| --- |\n| Value |');
    expect(tableMarkdown('| First |\n|---|\n| Value |\n\n| Second |\n|---|\n| Other |', 1)).toBe('| Second |\n| --- |\n| Other |');
  });
  it.each(LANGUAGES)('copies $name text and source language into one undoable Markdown node', language => {
    const project = createBlankProject('Tables', 'source');
    const version: NodeVersion = { header: 'Source', body: `Before\n\n| ${language.native} |\n|---|\n| ${language.sample} [[term]]⟦1⟧ |\n\nAfter`,
      createdAt: 2, generatedBy: 'chat', contentType: 'chat', language: language.id,
      sources: [{ n: 1, url: 'https://example.com', title: 'Reference' }],
      chat: { turnId: 'turn', title: 'Source', question: 'Question', state: 'complete', informationChunking: true, contextPath: [] } };
    version.termPreviews = { fingerprint: termPreviewFingerprint(version), entries: { term: 'A useful preview.' } };
    project.nodes.source = { id: 'source', type: 'chat', position: { x: 0, y: 0 }, frozen: false, currentVersionIndex: 0, versions: [version] };
    useGraphStore.setState({ project, activeProjectId: project.id });
    useGraphStore.temporal.getState().clear();
    const id = copyTableToNode('source', { turnId: 'turn', versionCreatedAt: 2 }, 0, { width: 800, bodyMaxHeight: 300 })!;
    const copy = useGraphStore.getState().project!.nodes[id]!;
    expect(copy.chat).toBeUndefined();
    expect(copy.versions[0]).toMatchObject({ markdownNote: true, contentType: 'answer', language: language.id, width: 800, bodyMaxHeight: 300, sources: version.sources });
    expect(copy.versions[0]!.body).toContain(language.sample);
    expect(copy.versions[0]!.body).not.toMatch(/Before|After/);
    expect(copy.versions[0]!.termPreviews).toEqual({ fingerprint: termPreviewFingerprint(copy.versions[0]!), entries: { term: 'A useful preview.' } });
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.nodes[id]).toBeUndefined();
  });
});
