import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatInlineTitle } from './ChatInlineTitle';

describe('title editing from the side panel', () => {
  it('edits in place on a new request, saves once, and does not repeat a consumed request on remount', () => {
    const onSave = vi.fn();
    const props = { title: 'Original title', label: 'Edit answer title', onSave, showEditButton: false };
    const view = render(<ChatInlineTitle {...props} editNonce={0} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    view.rerender(<ChatInlineTitle {...props} editNonce={1} />);
    const field = screen.getByRole('textbox', { name: 'Edit answer title' });
    expect(field).toHaveFocus();
    field.textContent = 'Updated title';
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledExactlyOnceWith('Updated title');
    expect(screen.queryByRole('textbox')).toBeNull();
    view.unmount();
    render(<ChatInlineTitle {...props} title="Updated title" editNonce={1} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('cancels without changing content or creating an undo entry', () => {
    const onSave = vi.fn();
    const props = { title: 'Original title', label: 'Edit chat title', onSave, showEditButton: false };
    const { rerender } = render(<ChatInlineTitle {...props} editNonce={0} />);
    rerender(<ChatInlineTitle {...props} editNonce={1} />);
    const field = screen.getByRole('textbox');
    field.textContent = 'Accidental edit';
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Original title')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
