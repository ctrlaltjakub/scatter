import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StructuredHeaderEditor } from './StructuredHeaderEditor';

describe('StructuredHeaderEditor', () => {
  it('shows every logical part in its own plain-text field', () => {
    render(<StructuredHeaderEditor
      value={{ prefix: 'Image', subject: 'Passage', question: 'Why?', suffix: 'explained' }}
      onChange={() => {}}
    />);
    expect(screen.getByRole('textbox', { name: 'PREFIX' })).toHaveValue('Image');
    expect(screen.getByRole('textbox', { name: 'SUBJECT' })).toHaveValue('Passage');
    expect(screen.getByRole('textbox', { name: 'QUESTION' })).toHaveValue('Why?');
    expect(screen.getByRole('textbox', { name: 'SUFFIX' })).toHaveValue('explained');
  });

  it('renders only available optional parts and always keeps the subject frame', () => {
    const { container } = render(<StructuredHeaderEditor value={{ subject: 'Topic' }} onChange={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Header' })).toBeInTheDocument();
    expect(screen.queryByText('SUBJECT')).toBeNull();
    expect(screen.queryByText('PREFIX')).toBeNull();
    expect(screen.queryByText('QUESTION')).toBeNull();
    expect(screen.queryByText('SUFFIX')).toBeNull();
    expect(container.querySelector('.structured-header-editor')).toHaveClass('is-regular', 'is-single-part');
  });

  it('exposes the compact constrained variant without changing the fields', () => {
    const { container } = render(
      <StructuredHeaderEditor
        value={{ prefix: 'Image', subject: 'Topic' }}
        onChange={() => {}}
        density="compact"
        constrained
      />,
    );
    expect(container.querySelector('.structured-header-editor')).toHaveClass('is-compact', 'is-constrained');
    expect(screen.getByRole('textbox', { name: 'PREFIX' })).toHaveValue('Image');
    expect(screen.getByRole('textbox', { name: 'SUBJECT' })).toHaveValue('Topic');
  });

  it('associates each floating label and moves focus through the logical parts', () => {
    render(<StructuredHeaderEditor
      value={{ prefix: 'Image', subject: 'Topic', question: 'Why?' }}
      onChange={() => {}}
    />);
    const prefix = screen.getByRole('textbox', { name: 'PREFIX' });
    const subject = screen.getByRole('textbox', { name: 'SUBJECT' });
    const question = screen.getByRole('textbox', { name: 'QUESTION' });
    expect(screen.getByText('SUBJECT')).toHaveAttribute('for', subject.id);

    subject.focus();
    expect(subject).toHaveFocus();
    expect(prefix).not.toHaveFocus();
    fireEvent.keyDown(subject, { key: 'Enter' });
    expect(question).toHaveFocus();
  });

  it('normalizes multiline paste without merging the logical fields', () => {
    const onChange = vi.fn();
    render(<StructuredHeaderEditor value={{ subject: 'Old' }} onChange={onChange} />);
    const subject = screen.getByRole('textbox', { name: 'Header' });
    fireEvent.paste(subject, { clipboardData: { getData: () => 'New\nsubject' } });
    expect(onChange).toHaveBeenCalledWith({ subject: 'New subjectOld' });
  });
});
