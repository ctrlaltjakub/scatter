import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { NodeHeader } from './NodeHeader';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});

describe('NodeHeader', () => {
  it('renders structured parts while exposing the complete flat title', () => {
    render(<NodeHeader parts={{ prefix: 'Image', subject: 'Long subject', question: 'Why?', suffix: 'explained' }} />);
    const title = screen.getByRole('heading');
    expect(title).toHaveAttribute('aria-label', 'Image: Long subject: Why? - explained');
    expect(title.textContent).toBe('Image: Long subject: Why? - explained');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('uses the shared generation pulse class only while active', () => {
    const { rerender } = render(<NodeHeader parts={{ subject: 'Topic' }} generating />);
    expect(screen.getByRole('heading')).toHaveClass('is-generating');
    rerender(<NodeHeader parts={{ subject: 'Topic' }} />);
    expect(screen.getByRole('heading')).not.toHaveClass('is-generating');
  });

  it.each(['English title', '中文标题', 'Título español', 'Titre français', 'Deutsche Überschrift', 'Título em português',
    'Titolo italiano', '日本語の見出し。', 'Русский заголовок', '한국어 제목', 'Nederlandse titel', 'Zażółć gęślą jaźń',
    'Judul Indonesia', 'Svensk rubrik', 'العنوان العربي', 'हिन्दी शीर्षक', 'Türkçe başlık', 'Tiêu đề tiếng Việt',
    'Český nadpis', 'Український заголовок'])('edits %s in place, with the caret at the end, and saves on an outside pointer click', title => {
    const onSave = vi.fn();
    const view = render(<NodeHeader parts={{ subject: title }} editNonce={0} onSave={onSave} />);
    view.rerender(<NodeHeader parts={{ subject: title }} editNonce={1} onSave={onSave} />);
    const field = screen.getByRole('textbox', { name: 'Edit header' });
    expect(field).toHaveFocus();
    expect(field).toHaveClass('node-title', 'is-editing');
    expect(window.getSelection()?.isCollapsed).toBe(true);
    const range = window.getSelection()!.getRangeAt(0);
    const before = range.cloneRange(); before.selectNodeContents(field); before.setEnd(range.endContainer, range.endOffset);
    expect(before.toString()).toBe(title);
    expect(screen.queryByRole('button')).toBeNull();
    field.textContent = `${title} edited`;
    fireEvent.pointerDown(document.body);
    expect(onSave).toHaveBeenCalledExactlyOnceWith(`${title} edited`);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('does not begin inline editing when no save handler is provided for a complex header', () => {
    const view = render(<NodeHeader parts={{ subject: 'Topic', question: 'Why?', suffix: 'explained' }} editNonce={0} />);
    view.rerender(<NodeHeader parts={{ subject: 'Topic', question: 'Why?', suffix: 'explained' }} editNonce={1} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
