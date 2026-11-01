import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { InteractiveNodeActions } from './InteractiveNodeActions';

vi.mock('@/lib/interactiveActions', () => ({ buildInteractiveNode: vi.fn(), stopInteractiveBuild: vi.fn() }));
vi.mock('@/lib/generate', () => ({ cancelNodeGenerationCascade: vi.fn() }));
vi.mock('@/hooks/useInteractiveGenerationAvailable', () => ({ useInteractiveGenerationAvailable: () => true }));
vi.mock('@/components/chat/ChatPanelControls', () => ({ ChatPanelGroup: () => <button>Group</button> }));
vi.mock('@/components/canvas/AddNodeMenu', () => ({ AddNodeMenu: () => <button>Add node</button> }));
vi.mock('./EditHeaderButton', () => ({ EditHeaderButton: () => <button>Edit header</button> }));
// Expose the forbidden action if it is accidentally restored to this panel.
vi.mock('./AddToProjectSourcesButton', () => ({ AddToProjectSourcesButton: () => <button>Add to project sources</button> }));

describe('interactive node side actions', () => {
  it.each([false, true])('omits source import while keeping program actions (generating: %s)', generating => {
    const node: ScatterNode = {
      id: 'interactive', type: 'interactive', position: { x: 0, y: 0 }, frozen: true,
      currentVersionIndex: 0, generating,
      versions: [{ header: 'Counter', body: 'Counter', createdAt: 1, generatedBy: 'interactive', contentType: 'interactive',
        interactive: { html: '<button>Count</button>', model: 'fixture', providerId: 'fixture', request: 'Counter' } }],
    };
    render(<InteractiveNodeActions node={node} isRoot={false} />);
    expect(screen.queryByRole('button', { name: /sources/i })).not.toBeInTheDocument();
    for (const name of ['Add node', 'Group', 'Edit header', 'Regenerate', 'Open enlarged', 'Restart']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });
});
