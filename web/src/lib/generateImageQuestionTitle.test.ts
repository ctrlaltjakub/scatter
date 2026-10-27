import { expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { generateImageQuestionTitle } from './generateImageQuestionTitle';
import { secondaryTaskCompletion } from './secondaryTaskCompletion';
import { removeNodeVersion } from './nodeVersions';

vi.mock('./secondaryTaskCompletion', () => ({ secondaryTaskCompletion: vi.fn() }));

it('finishes a background image-question title after deleting an older version', async () => {
  const project = createBlankProject('Image title ownership', 'n');
  project.nodes.n = { id: 'n', type: 'explain', position: { x: 0, y: 0 }, frozen: false, currentVersionIndex: 0,
    versions: [
      { createdAt: 1, header: 'Old answer', body: 'Earlier explanation.', generatedBy: 'explain' },
      { createdAt: 2, header: 'Generating...', body: 'Cigars carry health risks.', generatedBy: 'explain',
        imageQuestion: 'Is it healthy?', imageTitleState: 'pending' },
    ] };
  useGraphStore.setState({ project, activeProjectId: project.id });
  let finish!: (title: string) => void;
  vi.mocked(secondaryTaskCompletion).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = generateImageQuestionTitle(project.id, 'n', 1, 'Cigars carry health risks.', new AbortController().signal);
  useGraphStore.getState().updateNode('n', removeNodeVersion(project.nodes.n, 1)!);
  finish('Health risks of cigars');
  await pending;
  expect(useGraphStore.getState().project!.nodes.n!.versions).toMatchObject([
    { createdAt: 2, header: 'Health risks of cigars', imageTitleState: 'complete' },
  ]);
});
