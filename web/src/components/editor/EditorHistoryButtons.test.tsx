import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorHistoryButtons } from './EditorHistoryButtons';

describe('EditorHistoryButtons', () => {
  it('exposes local history without the hidden app toolbar', () => {
    const onUndo = vi.fn();
    render(
      <EditorHistoryButtons
        canUndo
        canRedo={false}
        onUndo={onUndo}
        onRedo={vi.fn()}
        noun="text edit"
      />,
    );
    const undo = screen.getByRole('button', { name: 'Undo text edit' });
    expect(undo).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Redo text edit' })).toBeDisabled();
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
