import { describe, it, expect } from 'vitest';
import { detectTouchTablet, type DeviceEnv } from './deviceDetect';

const env = (p: Partial<DeviceEnv>): DeviceEnv => ({
  userAgent: '',
  platform: '',
  maxTouchPoints: 0,
  pointerCoarse: false,
  ...p,
});

describe('detectTouchTablet', () => {
  it('detects Android phones/tablets via user agent', () => {
    expect(detectTouchTablet(env({
      userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120',
      platform: 'Linux armv8l', maxTouchPoints: 5, pointerCoarse: true,
    }))).toBe(true);
  });

  it('detects a classic iPad/iPhone user agent', () => {
    expect(detectTouchTablet(env({
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) Safari',
      platform: 'iPad', maxTouchPoints: 5, pointerCoarse: true,
    }))).toBe(true);
  });

  it('detects iPadOS that masquerades as desktop Mac (touch points)', () => {
    expect(detectTouchTablet(env({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari',
      platform: 'MacIntel', maxTouchPoints: 5, pointerCoarse: false,
    }))).toBe(true);
  });

  it('treats a real desktop Mac (no touch) as not-a-tablet', () => {
    expect(detectTouchTablet(env({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120',
      platform: 'MacIntel', maxTouchPoints: 0, pointerCoarse: false,
    }))).toBe(false);
  });

  it('treats a Linux/Windows desktop with a mouse as not-a-tablet', () => {
    expect(detectTouchTablet(env({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
      platform: 'Linux x86_64', maxTouchPoints: 0, pointerCoarse: false,
    }))).toBe(false);
    expect(detectTouchTablet(env({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
      platform: 'Win32', maxTouchPoints: 0, pointerCoarse: false,
    }))).toBe(false);
  });

  it('flags a generic coarse-pointer touch device (accepted false-positive on touch laptops)', () => {
    expect(detectTouchTablet(env({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
      platform: 'Win32', maxTouchPoints: 10, pointerCoarse: true,
    }))).toBe(true);
  });
});
