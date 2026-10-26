import { describe, expect, it } from 'vitest';
import { minimapSkeleton } from './minimapSkeleton';
import type { ContentType } from './nodeContentType';
import type { ScatterNode } from '@/store/types';

const node = (contentType: ContentType): ScatterNode => ({ id: 'n', type: 'root', position: { x: 0, y: 0 }, frozen: false,
  currentVersionIndex: 0, versions: [{ header: 'Example', body: '', createdAt: 1, generatedBy: 'root', contentType }] });
describe('minimap skeletons', () => {
  const types: ContentType[] = ['encyclopedic', 'explain', 'answer', 'chat', 'interactive', 'media'];
  it('distinguishes every node role without reading any text', () => {
    expect(new Set(types.map(type => JSON.stringify(minimapSkeleton(node(type), 50, 50)))).size).toBe(types.length);
  });
  it('never paints outside the card or compresses rows as cards get smaller', () => {
    for (const type of types) for (const width of [2, 12, 30, 80, 160]) for (const height of [2, 10, 20, 60, 110]) {
      for (const mark of minimapSkeleton(node(type), width, height)) {
        expect(mark.x).toBeGreaterThanOrEqual(2);
        expect(mark.x + mark.w).toBeLessThanOrEqual(width - 2 + .001);
        expect(mark.y + mark.h).toBeLessThanOrEqual(height - 2);
        expect(mark.h).toBeGreaterThanOrEqual(1);
      }
    }
  });
  it('draws taller, alternating messages when a single chat fills the minimap', () => {
    const marks = minimapSkeleton(node('chat'), 110, 110);
    const messages = marks.filter(mark => mark.alpha === .25);
    expect(messages.length).toBeGreaterThanOrEqual(4);
    expect(messages.length).toBeLessThanOrEqual(6);
    for (const [index, message] of messages.entries()) {
      expect(message.h).toBe(16);
      expect(message.x > 2).toBe(index % 2 === 0);
      if (index) expect(message.y - (messages[index - 1]!.y + message.h)).toBe(3);
      const text = marks.filter(mark => mark !== message && mark.y >= message.y && mark.y < message.y + message.h);
      expect(text).toHaveLength(2);
      for (const line of text) {
        expect(line.x).toBeGreaterThan(message.x);
        expect(line.x + line.w).toBeLessThan(message.x + message.w);
        expect(line.y + line.h).toBeLessThan(message.y + message.h);
      }
    }
  });
  it('keeps compact chat messages readable without squeezing the final row', () => {
    const messages = (width: number, height: number) => minimapSkeleton(node('chat'), width, height).filter(mark => mark.alpha === .25);
    expect(messages(30, 40).map(mark => mark.h)).toEqual([6, 6, 6]);
    expect(messages(30, 12)).toEqual([]);
    expect(messages(110, 24)).toEqual([]);
    expect(messages(110, 25)).toHaveLength(1);
  });
});
