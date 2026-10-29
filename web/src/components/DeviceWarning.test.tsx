import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDeviceWarnings } from '@/hooks/useDeviceWarnings';
import { DeviceWarning } from './DeviceWarning';

vi.mock('@/hooks/useDeviceWarnings', () => ({ useDeviceWarnings: vi.fn() }));
const dismissTablet = vi.fn();
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('device warning navigation', () => {
  it.each([
    { isTouchTablet: true, isNarrow: false, title: 'Scatter works best on desktop' },
    { isTouchTablet: false, isNarrow: true, title: 'Please widen your window' },
    { isTouchTablet: true, isNarrow: true, title: 'Scatter needs a desktop and a wider window' },
  ])('offers a prominent landing-page exit for $title', state => {
    vi.mocked(useDeviceWarnings).mockReturnValue({ ...state, tabletDismissed: false, dismissTablet });
    render(<DeviceWarning />);
    expect(screen.getByRole('dialog', { name: state.title })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Back to landing page' });
    expect(link).toHaveAttribute('href', 'https://www.scatter.study/?landing=1');
    expect(link).toHaveClass('btn-primary');
    expect(link).not.toHaveAttribute('target');
    if (state.isTouchTablet && !state.isNarrow) {
      fireEvent.click(screen.getByRole('button', { name: 'Use anyway' }));
      expect(dismissTablet).toHaveBeenCalledOnce();
    } else {
      expect(screen.queryByRole('button', { name: 'Use anyway' })).toBeNull();
      expect(dismissTablet).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('does not add a warning on a wide screen after tablet dismissal (%s)', isTouchTablet => {
    vi.mocked(useDeviceWarnings).mockReturnValue({ isTouchTablet, isNarrow: false, tabletDismissed: true, dismissTablet });
    const { container } = render(<DeviceWarning />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the exit available when a dismissed tablet is rotated to portrait', () => {
    vi.mocked(useDeviceWarnings).mockReturnValue({ isTouchTablet: true, isNarrow: true, tabletDismissed: true, dismissTablet });
    render(<DeviceWarning />);
    expect(screen.getByRole('link', { name: 'Back to landing page' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use anyway' })).toBeNull();
  });
});
