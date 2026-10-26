import { describe, expect, it } from 'vitest';
import { explicitFollowUpIntent } from './followUpIntent';
import { buildFollowUpClassifierPrompt } from './promptBuilder';

describe('follow-up output choice', () => {
  it.each([
    ['Compare these in an encyclopedic node', 'explore'],
    ['Please use a chat node for this explanation', 'chat'],
    ['Create an explanation node about this', 'explain'],
    ['Make an explain node', 'explain'],
    ['Do not use a chat node', undefined],
    ['What is a chat node?', undefined],
    ['Tell me about explanation methods', undefined],
  ])('%s respects explicit requests, not mere mentions', (question, expected) => {
    expect(explicitFollowUpIntent(question!)).toBe(expected);
  });
  it('gives the editable classifier rendering constraints and comparison routing instructions', () => {
    const prompt = buildFollowUpClassifierPrompt({ question: 'Compare these', context: { parent: null, grandparent: null } });
    expect(prompt).toContain('cannot render Markdown tables');
    expect(prompt).toContain('Use chat for tables, side-by-side comparisons');
    expect(prompt).toContain('First honor an explicit request');
  });
});
