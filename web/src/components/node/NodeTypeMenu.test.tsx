import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { NodeTypeMenu } from './NodeTypeMenu';

function node(contentType: 'encyclopedic' | 'explain'): ScatterNode {
  return {
    id: 'n', type: contentType === 'explain' ? 'explain' : 'term-click',
    position: { x: 0, y: 0 }, frozen: false, currentVersionIndex: 0,
    versions: [{ header: 'Topic', body: '', createdAt: 1, generatedBy: 'term-click', contentType }],
  };
}

describe('NodeTypeMenu', () => {
  it('offers only Explain for an encyclopedic node', () => {
    render(<NodeTypeMenu node={node('encyclopedic')} onClose={() => {}} />);
    expect(screen.getByRole('menuitem', { name: 'Explain' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Media' })).toBeNull();
  });

  it('offers only Encyclopedic for an explain node', () => {
    render(<NodeTypeMenu node={node('explain')} onClose={() => {}} />);
    expect(screen.getByRole('menuitem', { name: 'Encyclopedic' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Media' })).toBeNull();
  });
});
