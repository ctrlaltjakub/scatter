import { describe, expect, it } from 'vitest';
import { APP_VERSION, releaseChannel, releaseLabel, appPath, LANDING_URL, SUPPORT_URL } from './deployment';

describe('deployment identity', () => {
  it('keeps beta isolated regardless of imported settings or deployment alias', () => {
    expect(releaseChannel('beta.scatter.study', 'stable')).toBe('beta');
    expect(releaseChannel('preview.vercel.app', 'beta')).toBe('beta');
    expect(releaseChannel('www.scatter.study', 'stable')).toBe('stable');
    expect(releaseChannel('localhost', undefined)).toBe('stable');
  });
  it('keeps local development at the root and landing navigation explicit', () => {
    expect(appPath('/connect/openrouter')).toBe('/connect/openrouter');
    expect(new URL(LANDING_URL).searchParams.get('landing')).toBe('1');
    expect(SUPPORT_URL).toBe(LANDING_URL + '#support-me');
  });
  it('shows the package version and distinguishes demo from the two real releases', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(releaseLabel('stable', false)).toBe('Stable');
    expect(releaseLabel('beta', false)).toBe('Beta');
    expect(releaseLabel('stable', true)).toBe('Demo');
  });
});
