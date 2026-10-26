import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AddToProjectSourcesButton } from './AddToProjectSourcesButton';
import { addNodeVersionToSources } from '@/lib/nodeSource';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { NodeVersion } from '@/store/types';

vi.mock('@/lib/nodeSource', () => ({ addNodeVersionToSources: vi.fn(async () => {}) }));
const version: NodeVersion = { header: 'Selected version', body: 'Selected text', createdAt: 1, generatedBy: 'manual' };
beforeEach(() => { vi.clearAllMocks(); useGraphStore.getState().setProject(createBlankProject('Sources', 'n')); });

it.each([false, true])('imports the exact version and shows progress/success (panel=%s)', async panel => {
  let finish!: () => void;
  vi.mocked(addNodeVersionToSources).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<AddToProjectSourcesButton version={version} panel={panel} />);
  const button = screen.getByRole('button', { name: 'Add to project sources' });
  expect(button).toHaveAttribute('data-tip', expect.stringContaining('citation'));
  fireEvent.click(button);
  expect(screen.getByRole('button', { name: 'Adding to sources…' })).toBeDisabled();
  expect(button.querySelector('.animate-spin')).toBeTruthy();
  expect(addNodeVersionToSources).toHaveBeenCalledWith(useGraphStore.getState().project!.id, version);
  await act(async () => finish());
  expect(screen.getByRole('button', { name: 'Added to sources' })).toBeDisabled();
});
it('reports failure and permits retry', async () => {
  vi.mocked(addNodeVersionToSources).mockRejectedValueOnce(new Error('Storage is full. Free space and retry.'));
  render(<AddToProjectSourcesButton version={version} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add to project sources' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Storage is full');
  expect(screen.getByRole('button', { name: 'Add to project sources' })).toBeEnabled();
});
it('does not show an old asynchronous completion after switching versions', async () => {
  let finish!: () => void;
  vi.mocked(addNodeVersionToSources).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { rerender } = render(<AddToProjectSourcesButton version={version} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add to project sources' }));
  rerender(<AddToProjectSourcesButton version={{ ...version, createdAt: 2 }} />);
  await act(async () => finish());
  expect(screen.getByRole('button', { name: 'Add to project sources' })).toBeEnabled();
});
