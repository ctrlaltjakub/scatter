import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VersionCounter } from './VersionCounter';

describe('version counters', () => {
  it('keeps the current count, separator and total in independent ordered slots', () => {
    render(<VersionCounter current={12} total={99} />);
    const counter = screen.getByRole('group', { name: 'Version 12 of 99' });
    expect([...counter.children].map((child) => child.textContent)).toEqual(['12', '/', '99']);
    expect(counter.querySelector('.is-long')).toBeNull();
  });
  it('fades long counts individually while retaining complete accessible text', () => {
    render(<VersionCounter current={123} total={1450} noun="Answer" />);
    const counter = screen.getByRole('group', { name: 'Answer 123 of 1450' });
    expect(counter).toHaveAttribute('title', 'Answer 123 of 1450');
    expect(counter.querySelectorAll('.is-long')).toHaveLength(2);
  });
});
