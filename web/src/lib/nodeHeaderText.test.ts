import { describe, expect, it } from 'vitest';
import {
  displayNodeHeader,
  editableNodeHeader,
  fitHeaderParts,
  flattenHeaderParts,
  imageDisplayHeader,
  regenerateFromHeaderLabel,
  resolveNodeHeaderParts,
  semanticHeaderText,
} from './nodeHeaderText';
import type { Arrow, ScatterNode } from '@/store/types';

function node(version: ScatterNode['versions'][number], type: ScatterNode['type'] = 'follow-up'): ScatterNode {
  return {
    id: 'child', type, position: { x: 0, y: 0 }, frozen: false,
    versions: [version], currentVersionIndex: 0,
  };
}

const incoming: Record<string, Arrow> = {
  a1: {
    id: 'a1', fromNodeId: 'parent', toNodeId: 'child', kind: 'auto',
    sourceSelection: {
      sourceVersionCreatedAt: 1, createdAt: 2,
      text: 'The complete selected passage that was hidden from the compact label.',
      parts: [],
    },
  },
};

describe('complete editable node headers', () => {
  it('reconstructs selected-text question and explain headers from complete metadata', () => {
    const base = {
      header: 'The complete selected…: Why?', body: '', createdAt: 3,
      generatedBy: 'follow-up' as const, selectedTextQuestion: 'Why?',
    };
    expect(editableNodeHeader(node(base), incoming)).toBe(
      'The complete selected passage that was hidden from the compact label.: Why?',
    );
    expect(editableNodeHeader(node({ ...base, generatedBy: 'explain', contentType: 'explain' }, 'explain'), incoming))
      .toBe('The complete selected passage that was hidden from the compact label.: Why? - explained');
  });

  it('reconstructs generated-image titles from the complete prompt or selection', () => {
    const shared = { header: 'Image: short…', body: '', createdAt: 3, generatedBy: 'media' as const, contentType: 'media' as const };
    expect(editableNodeHeader(node({
      ...shared,
      imageGeneration: { prompt: 'provider prompt', promptSource: 'selected-text', providerId: 'p', model: 'm' },
    }, 'media'), incoming)).toBe('Image: The complete selected passage that was hidden from the compact label.');
    expect(editableNodeHeader(node({
      ...shared,
      imageGeneration: { prompt: 'the complete prompt written in the media node', promptSource: 'media-prompt', providerId: 'p', model: 'm' },
    }, 'media'), {})).toBe('Image: the complete prompt written in the media node');
  });

  it('upgrades older short image headers at display time without changing manual titles', () => {
    const longSelection = 'The complete selected passage that was hidden from the compact label.';
    const generated = node({
      header: 'Image: The complete selected…', body: '', createdAt: 3, generatedBy: 'media', contentType: 'media',
      imageGeneration: { prompt: 'provider prompt', promptSource: 'selected-text', providerId: 'p', model: 'm' },
    }, 'media');
    expect(displayNodeHeader(generated, incoming)).toBe(`Image: ${longSelection}`);
    generated.versions[0] = { ...generated.versions[0]!, generatedBy: 'manual', header: 'My short title' };
    expect(displayNodeHeader(generated, incoming)).toBe('My short title');
  });

  it('never overwrites an exact manual header with generation metadata', () => {
    expect(editableNodeHeader(node({
      header: 'My exact title', body: '', createdAt: 3, generatedBy: 'manual',
      selectedTextQuestion: 'Why?',
      imageGeneration: { prompt: 'old prompt', promptSource: 'selected-text', providerId: 'p', model: 'm' },
    }), incoming)).toBe('My exact title');
  });

  it('splits a legacy manual explain suffix without changing its exact flat title', () => {
    const manualExplain = node({
      header: 'My carefully edited topic - explained', body: '', createdAt: 3,
      generatedBy: 'manual', contentType: 'explain',
    }, 'explain');
    expect(resolveNodeHeaderParts(manualExplain, {})).toEqual({
      subject: 'My carefully edited topic', suffix: 'explained',
    });
    expect(editableNodeHeader(manualExplain, {})).toBe('My carefully edited topic - explained');
    expect(displayNodeHeader(manualExplain, {})).toBe('My carefully edited topic - explained');
  });
});

describe('image display headers', () => {
  it('keeps the full persisted subject and excludes visual add-ons from prompts', () => {
    const subject = 'word '.repeat(100).trim();
    const header = imageDisplayHeader(subject);
    expect(header).toBe(`Image: ${subject}`);
    const parts = { prefix: 'Illustration', subject, question: 'Why?', suffix: 'explained' };
    expect(flattenHeaderParts(parts)).toBe(`Illustration: ${subject}: Why? - explained`);
    expect(semanticHeaderText(parts)).toBe(`${subject}: Why?`);
  });
});

describe('responsive structured headers', () => {
  it('shortens the subject before touching the question and keeps add-ons', () => {
    const full = {
      prefix: 'Image',
      subject: 'A very long selected passage with several words that can disappear',
      question: 'Why does this happen?',
      suffix: 'explained',
    };
    const fitted = fitHeaderParts(full, (candidate) => flattenHeaderParts(candidate).length <= 58);
    expect(fitted.subject).toMatch(/…$/);
    expect(fitted.question).toBe(full.question);
    expect(fitted.prefix).toBe('Image');
    expect(fitted.suffix).toBe('explained');
  });

  it('shortens the question only when add-ons plus question cannot fit', () => {
    const fitted = fitHeaderParts(
      { prefix: 'Image', subject: 'Subject', question: 'An exceptionally long question with many words', suffix: 'explained' },
      (candidate) => flattenHeaderParts(candidate).length <= 32,
    );
    expect(fitted.subject).toBe('…');
    expect(fitted.question).toMatch(/…$/);
  });
});

describe('generation action labels', () => {
  it('names semantic fields in header order and ignores visual add-ons', () => {
    expect(regenerateFromHeaderLabel({
      prefix: 'Image', subject: 'A cell', question: 'Why?', suffix: 'explained',
    })).toBe('Regenerate from subject and question');
    expect(regenerateFromHeaderLabel({
      prefix: 'Image', subject: 'A cell', suffix: 'explained',
    })).toBe('Regenerate from subject');
    expect(regenerateFromHeaderLabel({ subject: 'A cell' })).toBe('Regenerate from header');
  });

  it('falls back safely when no semantic field has content', () => {
    expect(regenerateFromHeaderLabel({ subject: '', suffix: 'explained' })).toBe('Regenerate');
  });
});
