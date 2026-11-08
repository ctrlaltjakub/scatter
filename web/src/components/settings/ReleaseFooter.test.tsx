import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseFooter } from './ReleaseFooter';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('settings release footer', () => {
  it.each(['beta', 'stable', 'demo'] as const)('places the support and repository links above the %s version label', channel => {
    vi.stubEnv('NEXT_PUBLIC_RELEASE_CHANNEL', channel);
    vi.stubEnv('NEXT_PUBLIC_SCATTER_DEMO', channel === 'demo' ? '1' : '');
    render(<ReleaseFooter />);
    const release = screen.getByText(`v1.0.0 · ${{ beta: 'Beta', stable: 'Stable', demo: 'Demo' }[channel]}`);
    const repository = screen.getByRole('link', { name: 'GitHub repository (opens in a new tab)' });
    expect(repository).toHaveAttribute('href', 'https://github.com/ctrlaltjakub/scatter');
    expect(repository).toHaveAttribute('target', '_blank');
    expect(repository).toHaveAttribute('rel', 'noopener noreferrer');
    const landing = screen.getByRole('link', { name: 'Landing page' });
    const support = screen.getByRole('link', { name: 'Support me' });
    expect(support).toHaveAttribute('href', 'https://www.scatter.study/?landing=1#support-me');
    expect(support).toHaveAttribute('target', '_blank');
    expect(support).toHaveAttribute('rel', 'noopener noreferrer');
    expect(landing.nextElementSibling).toBe(support);
    expect(support.nextElementSibling).toBe(repository);
    expect(repository.nextElementSibling).toBe(release);
    expect(repository.parentElement).toHaveClass('settings-release-footer');
    expect(repository).toHaveTextContent(/^GitHub$/);
    expect(repository).not.toHaveClass('icon-btn');
    expect(repository).not.toHaveAttribute('data-link-control');
    expect(repository.querySelector('svg')).toBeNull();
    expect(landing).toHaveAttribute('href', 'https://www.scatter.study/?landing=1');
  });
});
