import { describe, expect, it } from 'vitest';
import type { Citation } from '@/providers/types';
import type { NodeVersion } from '@/store/types';
import {
  extractFactCheckUnits,
  factCheckBodyFingerprint,
  parseFactCheckFinding,
} from './factCheckCore';

const version = (body: string, contentType: NodeVersion['contentType'] = 'encyclopedic'): NodeVersion => ({
  header: 'Test',
  body,
  createdAt: 1,
  generatedBy: 'root',
  contentType,
});

describe('extractFactCheckUnits', () => {
  it('checks opening sentences before described children and keeps L1 as context', () => {
    const units = extractFactCheckUnits(version(
      '**One** fact. A second fact.⟦1⟧\n\n'
      + '- [[Section]]\n'
      + '  - **First**: Description one.\n'
      + '  - Second: Description two.',
    ));
    expect(units.map((unit) => [unit.id, unit.stage, unit.text, unit.sectionTitle])).toEqual([
      ['opening:0', 'opening', 'One fact.', undefined],
      ['opening:1', 'opening', 'A second fact.', undefined],
      ['bullet:0:0', 'bullets', 'First: Description one.', 'Section'],
      ['bullet:0:1', 'bullets', 'Second: Description two.', 'Section'],
    ]);
  });

  it('checks only prose sentences for explain and interactive versions', () => {
    for (const contentType of ['explain', 'interactive'] as const) {
      const units = extractFactCheckUnits(version(
        'First sentence. Second sentence!\n\n- An accidental bullet\n  - child: ignored',
        contentType,
      ));
      expect(units.map((unit) => unit.id)).toEqual(['opening:0', 'opening:1']);
      expect(units.every((unit) => unit.stage === 'prose')).toBe(true);
    }
  });

  it('uses the header and body for a stable fingerprint', () => {
    const a = version('Body');
    expect(factCheckBodyFingerprint(a)).toBe(factCheckBodyFingerprint({ ...a }));
    expect(factCheckBodyFingerprint(a)).not.toBe(factCheckBodyFingerprint({ ...a, body: 'Other' }));
  });
});

describe('parseFactCheckFinding', () => {
  const citations: Citation[] = [{
    url: 'https://example.com/research',
    title: 'Research',
    content: 'The study found a repeatable effect in three trials.',
  }, {
    url: 'https://counter.example/study',
    title: 'Counter-study',
  }];

  it('accepts searched URLs, evidence stance, and exact source excerpts', () => {
    const finding = parseFactCheckFinding(JSON.stringify({
      unitId: 'opening:0',
      verdict: 'supported',
      unverifiedReason: null,
      explanation: 'The cited study supports the passage.',
      evidence: [{
        url: 'https://example.com/research/',
        stance: 'supports',
        excerpt: 'repeatable effect in three trials',
      }],
    }), 'opening:0', citations);
    expect(finding.verdict).toBe('supported');
    expect(finding.evidence[0]).toMatchObject({
      stance: 'supports',
      excerptOrigin: 'source',
      domain: 'example.com',
    });
  });

  it('labels model-produced short excerpts and caps them at 25 words', () => {
    const excerpt = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const finding = parseFactCheckFinding(JSON.stringify({
      unitId: 'opening:0',
      verdict: 'contradicted',
      explanation: 'A counter-study contradicts it.',
      evidence: [{
        url: 'https://counter.example/study',
        stance: 'contradicts',
        excerpt,
      }],
    }), 'opening:0', citations);
    expect(finding.evidence[0]?.excerptOrigin).toBe('ai');
    expect(finding.evidence[0]?.excerpt?.split(/\s+/)).toHaveLength(25);
  });

  it('requires both sides for mixed evidence', () => {
    expect(() => parseFactCheckFinding(JSON.stringify({
      unitId: 'opening:0',
      verdict: 'mixed',
      explanation: 'Only one side was returned.',
      evidence: [{
        url: 'https://example.com/research',
        stance: 'supports',
      }],
    }), 'opening:0', citations)).toThrow(/both supporting and contradicting/i);
  });

  it('rejects fabricated URLs, unit IDs, and unsupported confident verdicts', () => {
    expect(() => parseFactCheckFinding(JSON.stringify({
      unitId: 'wrong',
      verdict: 'supported',
      explanation: 'No.',
      evidence: [],
    }), 'opening:0', citations)).toThrow(/wrong passage ID/i);
    expect(() => parseFactCheckFinding(JSON.stringify({
      unitId: 'opening:0',
      verdict: 'supported',
      explanation: 'No.',
      evidence: [{ url: 'https://invented.example', stance: 'supports' }],
    }), 'opening:0', citations)).toThrow(/not supplied by web search/i);
  });

  it('requires a reason for unverified passages', () => {
    expect(() => parseFactCheckFinding(JSON.stringify({
      unitId: 'opening:0',
      verdict: 'unverified',
      explanation: 'No reliable evidence was found.',
      evidence: [],
    }), 'opening:0', citations)).toThrow(/needs a reason/i);
  });
});
