import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarkdownView } from './MarkdownView';

describe('MarkdownView', () => {
  it('renders plain markdown', () => {
    render(<MarkdownView body="**bold** text" parentNodeId="p1" onReferenceClick={() => {}} />);
    expect(screen.getByText('bold')).toBeInTheDocument();
  });
  it('renders [[reference]] as a clickable chip', async () => {
    const fn = vi.fn();
    render(<MarkdownView body="See [[Pasteur]] for more." parentNodeId="p1" onReferenceClick={fn} />);
    const chip = screen.getByText('Pasteur');
    await userEvent.click(chip);
    expect(fn).toHaveBeenCalledWith('Pasteur', { withModifier: false });
  });
  it('gives collapsible prose a short action hint instead of repeating its contents', async () => {
    const { container } = render(<MarkdownView body={'- A long explanatory heading\n  - Nested detail'} parentNodeId="p1" onReferenceClick={() => {}} />);
    const heading = container.querySelector('.sc-collapsible-head')!;
    expect(heading).toHaveAttribute('data-tip', 'Pin open');
    await userEvent.click(heading);
    expect(container.querySelector('.sc-collapsible-head')).toHaveAttribute('data-tip', 'Unpin');
  });
});
