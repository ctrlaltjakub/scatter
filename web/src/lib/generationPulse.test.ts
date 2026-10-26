import { beforeEach, describe, expect, it } from 'vitest';
import { GENERATION_PULSE_MS, generationPulseDelay } from './generationPulse';

describe('generation pulse clock', () => {
  it('maps every mount onto the same repeating 1.4-second phase', () => {
    expect(GENERATION_PULSE_MS).toBe(1400);
    expect(generationPulseDelay(1550)).toBe('-150ms');
    expect(generationPulseDelay(2950)).toBe('-150ms');
  });
});
