import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GroupNameDisplay } from './GroupNameDisplay';

describe('GroupNameDisplay', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows animated progress only while the group title is pending', () => {
    const { container, rerender } = render(<GroupNameDisplay name="Generating title" active={false}
      titleGeneration={{ id: 'task', headers: ['One', 'Two'] }} />);
    expect(container.querySelector('[aria-busy="true"]')).toHaveTextContent('Generating title...');
    expect(container.querySelector('.group-title-dots')).not.toBeNull();
    rerender(<GroupNameDisplay name="Untitled group" active={false}
      titleGeneration={{ id: 'task', headers: ['One', 'Two'], error: 'Request failed' }} />);
    expect(container.querySelector('.group-title-dots')).toBeNull();
    expect(container.querySelector('[title]')).toHaveAttribute('title', expect.stringContaining('Request failed'));
    rerender(<GroupNameDisplay name="Learning Strategies" active={false} />);
    expect(container.querySelector('.group-title-dots')).toBeNull();
  });

  it('classifies one and two visible lines independently', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.hasAttribute('data-group-name-measure')) return 0;
      return this.textContent === 'Short' ? 18 : 36;
    });

    const { rerender } = render(<GroupNameDisplay name="Short" active={false} />);
    expect(screen.getByTestId('group-name-display')).toHaveAttribute('data-group-visible-lines', '1');

    rerender(<GroupNameDisplay name="Two wrapped lines" active={false} />);
    expect(screen.getByTestId('group-name-display')).toHaveAttribute('data-group-visible-lines', '2');
  });

  it('loops only an overflowing active name and restores its beginning', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(72);

    const { rerender } = render(<GroupNameDisplay name="Long group name" active={false} />);
    expect(screen.queryByTestId('group-name-loop')).toBeNull();

    rerender(<GroupNameDisplay name="Long group name" active />);
    expect(screen.getByTestId('group-name-loop')).toBeVisible();

    rerender(<GroupNameDisplay name="Long group name" active={false} />);
    expect(screen.getByTestId('group-name-static')).toBeVisible();
    expect(screen.queryByTestId('group-name-loop')).toBeNull();
  });
});
