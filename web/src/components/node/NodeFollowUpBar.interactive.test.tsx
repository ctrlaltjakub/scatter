import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { buildInteractiveNode } from '@/lib/interactiveActions';
import { spawnFollowUp } from '@/lib/generate';
import { NodeFollowUpBar } from './NodeFollowUpBar';
import { FOLLOW_UP_ROUTING_TOOLTIP } from '@/lib/followUpPlaceholder';

vi.mock('@/lib/interactiveActions', () => ({ buildInteractiveNode: vi.fn() }));
vi.mock('@/lib/generate', () => ({ spawnFollowUp: vi.fn(), generateEmptyTextNode: vi.fn(), modifyNode: vi.fn(), modifySelection: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  const project = createBlankProject('Programs', 'program');
  project.nodes.program = { id: 'program', type: 'interactive', position: { x: 0, y: 0 }, frozen: false,
    currentVersionIndex: 0, versions: [{ header: 'New interactive', body: '', contentType: 'interactive', interactiveStandalone: true, createdAt: 1, generatedBy: 'interactive' }] };
  useGraphStore.setState({ project, activeProjectId: project.id });
});

it('generates an empty interactive in place without text selection scope', () => {
  render(<NodeFollowUpBar nodeId="program"/>);
  expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'What would you like to build?');
  expect(screen.getByRole('textbox')).not.toHaveAttribute('data-tip');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Build a calculator' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
  expect(buildInteractiveNode).toHaveBeenCalledWith('program', 'Build a calculator', 'create');
  expect(screen.queryByText('whole node')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Modify' })).toBeNull();
});

it('separates asking a question from changing the existing program', () => {
  const node = useGraphStore.getState().project!.nodes.program!;
  useGraphStore.getState().updateNode(node.id, { versions: [{ ...node.versions[0]!, interactive: { html: '<html/>', request: 'Calculator', model: 'model', providerId: 'provider' } }] });
  render(<NodeFollowUpBar nodeId="program"/>);
  expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Ask a follow-up question or describe a change to this interactive…');
  expect(screen.getByRole('textbox')).toHaveAttribute('data-tip', FOLLOW_UP_ROUTING_TOOLTIP);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'How is this calculated?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }));
  expect(spawnFollowUp).toHaveBeenCalledWith('program', 'How is this calculated?');
  expect(buildInteractiveNode).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Add a reset button' } });
  fireEvent.click(screen.getByRole('button', { name: 'Modify' }));
  expect(buildInteractiveNode).toHaveBeenCalledWith('program', 'Add a reset button', 'modify');
});
