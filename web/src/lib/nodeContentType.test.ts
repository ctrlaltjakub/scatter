import { describe, expect, it } from 'vitest';
import { formatExplainHeader, stripExplainHeaderSuffix } from './nodeContentType';

describe('explain header formatting', () => {
  it('adds the automatic suffix idempotently', () => {
    expect(formatExplainHeader('Entropy')).toBe('Entropy - explained');
    expect(formatExplainHeader('Entropy - explained')).toBe('Entropy - explained');
    expect(formatExplainHeader(' Entropy - EXPLAINED ')).toBe('Entropy - explained');
  });

  it('strips the suffix before using the header as a model subject', () => {
    expect(stripExplainHeaderSuffix('Entropy - explained')).toBe('Entropy');
    expect(stripExplainHeaderSuffix('Entropy')).toBe('Entropy');
  });
});
