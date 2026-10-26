import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReferenceChip } from './ReferenceChip';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { NodeContentInteractionProvider } from './NodeContentInteractionContext';

describe('ReferenceChip', () => {
  beforeEach(() => useLiveViewportStore.getState().clear());
  it('renders the term', () => {
    render(<ReferenceChip term="lactic acid" parentNodeId="p1" onClick={() => {}} />);
    expect(screen.getByText('lactic acid')).toBeInTheDocument();
  });
  it('calls onClick with the term', async () => {
    const fn = vi.fn();
    render(<ReferenceChip term="Pasteur" parentNodeId="p1" onClick={fn} />);
    await userEvent.click(screen.getByText('Pasteur'));
    expect(fn).toHaveBeenCalledWith('Pasteur', { withModifier: false });
  });
  it('renders rich children when provided, but still spawns/looks-up by term', async () => {
    const fn = vi.fn();
    const { container } = render(
      <ReferenceChip term="The whole title" parentNodeId="p1" onClick={fn}>
        <strong>The whole title</strong>
      </ReferenceChip>,
    );
    const chip = container.querySelector('.ref-chip')!;
    expect(chip.querySelector('strong')).not.toBeNull(); // rich children, not the bare term
    expect(chip.textContent).toBe('The whole title');
    await userEvent.click(chip);
    expect(fn).toHaveBeenCalledWith('The whole title', { withModifier: false });
  });

  it('guards activation below 35% without re-rendering at the threshold', async () => {
    const fn = vi.fn();
    render(<ReferenceChip term="chlorophyll" parentNodeId="p1" onClick={fn} />);
    const chip = screen.getByRole('button', { name: 'chlorophyll' });
    act(() => useLiveViewportStore.getState().setZoom(0.34));
    await userEvent.click(chip);
    chip.focus();
    await userEvent.keyboard('{Enter}');
    expect(fn).not.toHaveBeenCalled();

    act(() => useLiveViewportStore.getState().setZoom(0.35));
    await userEvent.click(chip);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('remains interactive in the screen-sized viewer below 35% canvas zoom', async () => {
    const fn = vi.fn();
    act(() => useLiveViewportStore.getState().setZoom(0.1));
    render(
      <NodeContentInteractionProvider value={{ ignoreCanvasZoomForTerms: true }}>
        <ReferenceChip term="resonance" parentNodeId="p1" onClick={fn} />
      </NodeContentInteractionProvider>,
    );
    const chip = screen.getByRole('button', { name: 'resonance' });
    expect(chip).toHaveAttribute('aria-disabled', 'false');
    expect(chip).toHaveAttribute('tabindex', '0');
    await userEvent.click(chip);
    expect(fn).toHaveBeenCalledWith('resonance', { withModifier: false });
  });
});
