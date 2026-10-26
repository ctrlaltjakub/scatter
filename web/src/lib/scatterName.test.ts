import { describe, it, expect } from 'vitest';
import { isAutoScatterName } from '@/store/projectActions';

// Projects are now named after the exact topic the user types in the picker
// (no AI auto-naming). `isAutoScatterName` still decides whether a project's
// name is a default placeholder that the topic should overwrite.
describe('isAutoScatterName', () => {
  it('recognizes the current "project" default names', () => {
    expect(isAutoScatterName('My project')).toBe(true);
    expect(isAutoScatterName('New project')).toBe(true);
    expect(isAutoScatterName('New project 2')).toBe(true);
    expect(isAutoScatterName('Untitled project')).toBe(true);
    expect(isAutoScatterName('  My project  ')).toBe(true);
  });

  it('still recognizes the older "scatter" defaults (backward compat)', () => {
    expect(isAutoScatterName('My scatter')).toBe(true);
    expect(isAutoScatterName('New scatter 2')).toBe(true);
    expect(isAutoScatterName('Untitled scatter')).toBe(true);
  });

  it('treats real titles (incl. typed topics) as user-chosen', () => {
    expect(isAutoScatterName('Black Holes')).toBe(false);
    expect(isAutoScatterName('My project notes')).toBe(false);
    expect(isAutoScatterName('Project')).toBe(false);
    expect(isAutoScatterName('How to study with ADHD')).toBe(false);
  });
});
