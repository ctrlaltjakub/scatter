import { expect, it } from 'vitest';
import { unchipHeaders } from './parser';
import { applyTermSelection } from './termMarking';

it('keeps literal brackets intact through encyclopedic selection AND redundant-title cleanup', () => {
  const source = 'Memory matters. `[[Memory]]` stays literal.\n\n```text\n[[Memory]]\n```';
  const marked = applyTermSelection(source, '{"terms":["Memory"]}')!;
  expect(unchipHeaders(marked, ['Memory'])).toBe(source);
});
