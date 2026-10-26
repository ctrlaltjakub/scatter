import { describe, expect, it } from 'vitest';
import { resolveGoogleDrivePickerConfiguration } from './googleDriveSourcePicker';

describe('Google Drive source picker configuration', () => {
  it('uses an explicit deployment configuration before the shared one', () => {
    expect(resolveGoogleDrivePickerConfiguration(
      ' custom-key ',
      ' custom-app ',
      'https://scatter.study',
    )).toEqual({ developerKey: 'custom-key', appId: 'custom-app' });
  });

  it('uses Scatter\'s restricted Picker configuration on canonical and local origins', () => {
    for (const origin of [
      'https://scatter.study',
      'https://www.scatter.study',
      'http://localhost:3000',
      'http://127.0.0.1:3001',
      'http://localhost:4173',
      'http://127.0.0.1:5173',
      'http://localhost:8080',
    ]) {
      const configuration = resolveGoogleDrivePickerConfiguration(undefined, undefined, origin);
      expect(configuration?.developerKey).toMatch(/^AIza/);
      expect(configuration?.appId).toBe('992714113012');
    }
  });

  it('requires an explicit configuration on an unregistered self-hosted origin', () => {
    expect(resolveGoogleDrivePickerConfiguration(
      undefined,
      undefined,
      'https://self-hosted.example',
    )).toBeNull();
  });
});
