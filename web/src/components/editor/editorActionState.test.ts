import { describe, expect, it } from 'vitest';
import { outlineLevelToolsDisabled } from './editorActionState';

describe('text editor outline action state', () => {
  it('greys out promote and demote for prose-only explain nodes', () => {
    expect(outlineLevelToolsDisabled('explain', true, false)).toBe(true);
    expect(outlineLevelToolsDisabled('encyclopedic', true, false)).toBe(false);
  });

  it('retains the ordinary editor readiness and streaming gates', () => {
    expect(outlineLevelToolsDisabled('encyclopedic', false, false)).toBe(true);
    expect(outlineLevelToolsDisabled('encyclopedic', true, true)).toBe(true);
  });
});
