import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivatePath, validatePush } from './publication-policy.mjs';

test('private workspace files cannot be forced into a publication', () => {
  for (const path of ['AGENTS.md', 'web/AGENT.md', 'plans/next.md', '.codex/config', 'web/src/prototypes/page.tsx', 'web/test-results/trace.zip', 'example_project/project.json']) {
    assert.equal(isPrivatePath(path), true, path);
  }
  for (const path of ['README.md', 'web/src/opfs/settings.ts', 'web/e2e/settings.spec.ts', 'assets/readme/open-app.svg', '.github/workflows/checks.yml']) {
    assert.equal(isPrivatePath(path), false, path);
  }
});

test('beta pushes are normal; stable needs exact commit approval', () => {
  const sha = 'a'.repeat(40), old = 'b'.repeat(40);
  assert.doesNotThrow(() => validatePush(`refs/heads/beta ${sha} refs/heads/beta ${old}`));
  const main = `refs/heads/beta ${sha} refs/heads/main ${old}`;
  assert.throws(() => validatePush(main), /Stable push blocked/);
  assert.throws(() => validatePush(main, old), /Stable push blocked/);
  assert.doesNotThrow(() => validatePush(main, sha));
  assert.throws(() => validatePush(`(delete) ${'0'.repeat(40)} refs/heads/main ${sha}`));
});
