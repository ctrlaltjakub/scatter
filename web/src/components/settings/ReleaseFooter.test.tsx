import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseFooter } from './ReleaseFooter';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('settings release footer', () => {
  it.each(['beta', 'stable'] as const)('places the GitHub logo between the landing link and %s version label', channel => {
    vi.stubEnv('NEXT_PUBLIC_RELEASE_CHANNEL', channel);
    render(<ReleaseFooter />);
    const release = screen.getByText(new RegExp(`v.* · ${channel === 'beta' ? 'Beta' : 'Stable'}`));
    const repository = screen.getByRole('link', { name: 'GitHub repository (opens in a new tab)' });
    expect(repository).toHaveAttribute('href', 'https://github.com/ctrlaltjakub/scatter');
    expect(repository).toHaveAttribute('target', '_blank');
    expect(repository).toHaveAttribute('rel', 'noopener noreferrer');
    expect(repository).toHaveAttribute('data-link-control');
    const landing = screen.getByRole('link', { name: 'Landing page' });
    expect(repository.previousElementSibling).toBe(landing);
    expect(repository.nextElementSibling).toBe(release);
    expect(repository.parentElement).toHaveClass('settings-release-footer');
    expect(repository.querySelector('svg')).toHaveAttribute('viewBox', '0 0 98 96');
    expect(repository.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(landing).toHaveAttribute('href', 'https://www.scatter.study/?landing=1');
  });
});
