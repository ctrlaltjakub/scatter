import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MediaModeToggle } from './MediaModeToggle';

describe('MediaModeToggle', () => {
  it('presents a switch between generation and files/links', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<MediaModeToggle mode="generate" onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Switch to files and links' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith('attach');

    rerender(<MediaModeToggle mode="attach" onChange={onChange} />);
    expect(screen.getByRole('switch', { name: 'Switch to AI image generation' }))
      .toHaveAttribute('aria-checked', 'true');
  });

  it('greys out and blocks the AI direction when no image model is selected', async () => {
    const onChange = vi.fn();
    render(<MediaModeToggle mode="attach" onChange={onChange} generationAvailable={false} />);
    const toggle = screen.getByRole('switch', { name: 'Switch to AI image generation' });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});
