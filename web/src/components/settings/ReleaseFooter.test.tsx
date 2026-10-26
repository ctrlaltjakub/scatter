import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseFooter } from './ReleaseFooter';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('settings release footer', () => {
  it.each(['beta', 'stable'] as const)('places a plain GitHub link between the landing link and %s version label', channel => {
    vi.stubEnv('NEXT_PUBLIC_RELEASE_CHANNEL', channel);
    render(<ReleaseFooter />);
    const release = screen.getByText(new RegExp(`v.* · ${channel === 'beta' ? 'Beta' : 'Stable'}`));
    const repository = screen.getByRole('link', { name: 'GitHub repository (opens in a new tab)' });
    expect(repository).toHaveAttribute('href', 'https://github.com/ctrlaltjakub/scatter');
    expect(repository).toHaveAttribute('target', '_blank');
    expect(repository).toHaveAttribute('rel', 'noopener noreferrer');
    const landing = screen.getByRole('link', { name: 'Landing page' });
    expect(landing.nextElementSibling).toBe(repository);
    expect(repository.nextElementSibling).toBe(release);
    expect(repository.parentElement).toHaveClass('settings-release-footer');
    expect(repository).toHaveTextContent(/^GitHub$/);
    expect(repository).not.toHaveClass('icon-btn');
    expect(repository).not.toHaveAttribute('data-link-control');
    expect(repository.querySelector('svg')).toBeNull();
    expect(landing).toHaveAttribute('href', 'https://www.scatter.study/?landing=1');
  });
});
