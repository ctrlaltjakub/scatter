import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createBlankProject } from '@/store/useGraphStore';
import { DEFAULT_PHYSICS_CONFIG } from '@/physics/defaults';
import { listRecordings } from '@/lib/sandboxRecording';
import { RecordingPanel } from './RecordingPanel';

vi.mock('@/lib/sandboxRecording', () => ({
  listRecordings: vi.fn(), saveRecording: vi.fn(), deleteRecording: vi.fn(),
}));

describe('RecordingPanel frame counts', () => {
  it.each([0, 1, 2])('pluralizes live and saved counts for %s frames', (count) => {
    vi.mocked(listRecordings).mockReturnValue([{
      id: 'recording', name: 'Test recording', createdAt: 1, durationMs: 1000,
      initialProject: createBlankProject('Test', 'root'), physicsConfig: DEFAULT_PHYSICS_CONFIG,
      frames: Array.from({ length: count }, (_, index) => ({ t: index, nodes: [], arrows: {} })),
    }]);
    render(<RecordingPanel recording liveFrameCount={count} replaying={false} replayProgress={0}
      onStart={vi.fn()} onStop={vi.fn()} onReplay={vi.fn()} onStopReplay={vi.fn()} onReset={vi.fn()} />);
    const label = `${count} frame${count === 1 ? '' : 's'}`;
    expect(screen.getByText(`● Recording — ${label}`)).toBeInTheDocument();
    expect(screen.getByTitle(`${label}, 1.0s`)).toBeInTheDocument();
  });
});
