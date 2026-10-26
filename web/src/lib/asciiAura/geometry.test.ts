import { describe, expect, test } from 'vitest';
import { distanceToRectBorder } from './geometry';

/**
 * distanceToRectBorder returns the shortest distance from a point to the
 * border of an axis-aligned rect, or 0 if the point is inside (or on the
 * border). Used by the aura layer to figure out how close each grid cell
 * is to each node — which feeds the density ramp.
 */

describe('distanceToRectBorder', () => {
  // Rect at (0, 0, 100, 100)
  const r = [0, 0, 100, 100] as const;

  test('point inside rect → 0', () => {
    expect(distanceToRectBorder(50, 50, ...r)).toBe(0);
  });

  test('point on edge → 0', () => {
    expect(distanceToRectBorder(50, 0, ...r)).toBe(0);
    expect(distanceToRectBorder(100, 50, ...r)).toBe(0);
  });

  test('point above rect → vertical distance', () => {
    expect(distanceToRectBorder(50, -30, ...r)).toBe(30);
  });

  test('point below rect → vertical distance', () => {
    expect(distanceToRectBorder(50, 150, ...r)).toBe(50);
  });

  test('point left of rect → horizontal distance', () => {
    expect(distanceToRectBorder(-20, 50, ...r)).toBe(20);
  });

  test('point right of rect → horizontal distance', () => {
    expect(distanceToRectBorder(120, 50, ...r)).toBe(20);
  });

  test('point NW of rect → diagonal distance (3-4-5 triangle)', () => {
    expect(distanceToRectBorder(-3, -4, ...r)).toBeCloseTo(5);
  });

  test('point SE of rect → diagonal distance (3-4-5 triangle)', () => {
    expect(distanceToRectBorder(103, 104, ...r)).toBeCloseTo(5);
  });

  test('rect with non-zero origin', () => {
    expect(distanceToRectBorder(10, 10, 100, 100, 50, 50)).toBeCloseTo(Math.sqrt(2) * 90);
  });
});
