import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReferenceChip } from './ReferenceChip';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { NodeContentInteractionProvider } from './NodeContentInteractionContext';
import { LANGUAGES } from '@/lib/languages';

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

  it.each(LANGUAGES)('keeps $name term text and lets the collapsed bullet own activation', ({ sample }) => {
    const spawn = vi.fn(), expand = vi.fn();
    const { container, rerender } = render(<div className="sc-ab-item" aria-expanded={false} onClick={expand} onKeyDown={expand}>
      <ReferenceChip term={sample} parentNodeId="p1" onClick={spawn} />
    </div>);
    const chip = container.querySelector<HTMLElement>('.ref-chip')!;
    for (const key of ['Enter',' ']) fireEvent.keyDown(chip, {key});
    fireEvent.click(chip, {ctrlKey:true});
    fireEvent.click(chip, {metaKey:true});
    expect(spawn).not.toHaveBeenCalled();
    expect(expand).toHaveBeenCalledTimes(4);
    expect(chip.dataset.referenceTerm).toBe(sample);
    rerender(<div className="sc-ab-item" aria-expanded onClick={expand} onKeyDown={expand}>
      <ReferenceChip term={sample} parentNodeId="p1" onClick={spawn} />
    </div>);
    fireEvent.click(chip, {ctrlKey:true});
    expect(spawn).toHaveBeenCalledWith(sample,{withModifier:true});
    expect(expand).toHaveBeenCalledTimes(4);
  });

  it('does not expand hidden bullets from term activation below the overview threshold', () => {
    const spawn = vi.fn(), expand = vi.fn();
    render(<div className="sc-ab-item" aria-expanded={false} onClick={expand} onKeyDown={expand}>
      <ReferenceChip term="Hidden term" parentNodeId="p1" onClick={spawn} />
    </div>);
    act(() => useLiveViewportStore.getState().setZoom(.2));
    const chip = screen.getByText('Hidden term');
    fireEvent.click(chip);
    fireEvent.keyDown(chip, {key:'Enter'});
    expect(spawn).not.toHaveBeenCalled();
    expect(expand).not.toHaveBeenCalled();
  });
});
