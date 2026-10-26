import { describe, it, expect } from 'vitest';
import { stripChipMarkers, wholeTerm, findBulletIdxContainingTerm } from './bulletTerms';
import type { Bullet } from './bulletParse';

describe('stripChipMarkers', () => {
  it('removes [[ ]] markers, keeping the inner text and any bold', () => {
    expect(stripChipMarkers('The [[Krebs cycle]] in cells')).toBe('The Krebs cycle in cells');
    expect(stripChipMarkers('[[**One**]]')).toBe('**One**');
    expect(stripChipMarkers('plain text')).toBe('plain text');
  });
});

describe('wholeTerm', () => {
  it('strips markers + bold + trims to a clean term', () => {
    expect(wholeTerm('The [[Krebs cycle]] in cells')).toBe('The Krebs cycle in cells');
    expect(wholeTerm('[[**One**]]')).toBe('One');
    expect(wholeTerm('[[***Therapy***]]')).toBe('Therapy');
    expect(wholeTerm('_Therapist_')).toBe('Therapist');
    expect(wholeTerm('  Spaced  ')).toBe('Spaced');
  });
});

describe('findBulletIdxContainingTerm', () => {
  const b = (title: string, children: { name: string; desc: string }[] = []): Bullet => ({
    title,
    children,
  });

  it('matches a whole-title term (markers ignored)', () => {
    const bullets = [b('Intro'), b('The [[Krebs cycle]] in cells')];
    expect(findBulletIdxContainingTerm(bullets, 'The Krebs cycle in cells')).toBe(1);
  });

  it('matches a whole-name term (markers ignored)', () => {
    const bullets = [b('Topic', [{ name: '[[Glyco]]lysis', desc: 'first step' }])];
    expect(findBulletIdxContainingTerm(bullets, 'Glycolysis')).toBe(0);
  });

  it('still matches a literal [[term]] inside a description (back-compat)', () => {
    const bullets = [b('Topic', [{ name: 'Step', desc: 'see [[Krebs]] here' }])];
    expect(findBulletIdxContainingTerm(bullets, 'Krebs')).toBe(0);
  });

  it('returns null when the term is nowhere in a bullet', () => {
    const bullets = [b('Topic', [{ name: 'Step', desc: 'nothing here' }])];
    expect(findBulletIdxContainingTerm(bullets, 'absent')).toBeNull();
  });
});
