import { describe, expect, test } from 'vitest';
import {
  findMarkerBounds,
  insertMarkedSection,
  nextMarkerId,
  removeMarkers,
  replaceBetweenMarkers,
  startMarker,
  endMarker,
  stripMarkers,
} from './rewriteMarkers';

describe('rewriteMarkers', () => {
  test('nextMarkerId yields 8 hex chars and increments uniquely', () => {
    const a = nextMarkerId();
    const b = nextMarkerId();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  test('insertMarkedSection wraps section text between marker pair', () => {
    const id = nextMarkerId();
    const body = 'AAABBBCCC';
    const out = insertMarkedSection(body, 3, 6, id, 'BBB');
    expect(out).toBe(`AAA${startMarker(id)}BBB${endMarker(id)}CCC`);
  });

  test('findMarkerBounds locates the inner-text char range', () => {
    const id = nextMarkerId();
    const body = `pre${startMarker(id)}middle${endMarker(id)}post`;
    const bounds = findMarkerBounds(body, id);
    expect(bounds).not.toBeNull();
    expect(body.slice(bounds!.start, bounds!.end)).toBe('middle');
  });

  test('replaceBetweenMarkers substitutes only this rewrite\'s slice', () => {
    const idA = nextMarkerId();
    const idB = nextMarkerId();
    const body = `${startMarker(idA)}A${endMarker(idA)} sep ${startMarker(idB)}B${endMarker(idB)}`;
    const after = replaceBetweenMarkers(body, idA, 'A-new');
    expect(after).toBe(`${startMarker(idA)}A-new${endMarker(idA)} sep ${startMarker(idB)}B${endMarker(idB)}`);
  });

  test('replaceBetweenMarkers is a no-op when markers are missing', () => {
    const id = nextMarkerId();
    const body = 'plain text no markers';
    expect(replaceBetweenMarkers(body, id, 'x')).toBe(body);
  });

  test('stripMarkers removes ALL marker pairs and leaves inner text', () => {
    const idA = nextMarkerId();
    const idB = nextMarkerId();
    const body = `pre${startMarker(idA)}A${endMarker(idA)} mid ${startMarker(idB)}B${endMarker(idB)} post`;
    expect(stripMarkers(body)).toBe('preA mid B post');
  });

  test('removeMarkers strips only THIS rewrite\'s marker pair', () => {
    const idA = nextMarkerId();
    const idB = nextMarkerId();
    const body = `${startMarker(idA)}A${endMarker(idA)}-${startMarker(idB)}B${endMarker(idB)}`;
    expect(removeMarkers(body, idA)).toBe(`A-${startMarker(idB)}B${endMarker(idB)}`);
  });
});
