import { describe, expect, it } from 'vitest';
import { releaseChannel, appPath, LANDING_URL } from './deployment';

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
  });
});
