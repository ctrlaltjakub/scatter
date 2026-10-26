import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebglUnavailableNotice } from './WebglUnavailableNotice';

describe('WebglUnavailableNotice', () => {
  it('explains the missing canvas features without claiming the app works normally', () => {
    render(<WebglUnavailableNotice />);
    expect(screen.getByText('Canvas graphics unavailable')).toBeInTheDocument();
    expect(screen.getByText(/WebGL2/)).toBeInTheDocument();
    expect(screen.getByText(/node auras, selection markers, and important labels are missing/i)).toBeInTheDocument();
    expect(screen.getByText(/Scatter cannot function correctly/i)).toBeInTheDocument();
    expect(screen.queryByText(/the rest of the app works normally/i)).not.toBeInTheDocument();
  });

  it('describes possible causes and recovery steps without claiming to know the cause', () => {
    render(<WebglUnavailableNotice />);
    expect(screen.getByText(/possible causes/i).closest('p')).toHaveTextContent(/graphics acceleration is disabled/i);
    expect(screen.getByText(/possible causes/i).closest('p')).toHaveTextContent(/browser or graphics driver/i);
    expect(screen.getByText(/what to try/i).closest('p')).toHaveTextContent(/restart the browser/i);
    expect(screen.getByText(/what to try/i).closest('p')).toHaveTextContent(/try another browser/i);
  });

  it('skips (unmounts) when "Dismiss warning" is clicked', async () => {
    render(<WebglUnavailableNotice />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss warning' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('skips when the ✕ close button is clicked', async () => {
    render(<WebglUnavailableNotice />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the warning again after a remount instead of saving dismissal permanently', async () => {
    const first = render(<WebglUnavailableNotice />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss warning' }));
    first.unmount();
    render(<WebglUnavailableNotice />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
