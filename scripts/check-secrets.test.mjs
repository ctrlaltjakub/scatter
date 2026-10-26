import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { forbiddenPath, scanContent } from './check-secrets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'scripts/check-secrets.mjs');
// Generated synthetic samples, never operational credentials.
const samples = [
  ['OpenAI project key', 'sk-' + 'proj-' + 'a'.repeat(80)],
  ['OpenAI legacy key', 'sk-' + 'a'.repeat(48)],
  ['OpenRouter key', 'sk-' + 'or-v1-' + 'b'.repeat(64)],
  ['Anthropic key', 'sk-' + 'ant-usr-' + 'c'.repeat(90)],
  ['Google API key', 'AI' + 'za' + 'd'.repeat(35)],
  ['Gemini authorization key', 'AQ' + '.' + 'e'.repeat(48)],
  ['GitHub token', 'gh' + 'p_' + 'f'.repeat(36)],
  ['Private key', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'],
];

for (const [rule, sample] of samples) {
  test('detects ' + rule + ' without printing its value', () => {
    const findings = scanContent('safe\nconst key = "' + sample + '";', 'web/test.ts');
    assert.deepEqual(findings, [{ path: 'web/test.ts', line: 2, rule }]);
    assert.ok(!JSON.stringify(findings).includes(sample));
  });
}

test('permits only an exact reviewed fingerprint, without permitting neighboring keys', () => {
  const sample = samples[4][1];
  const digest = createHash('sha256').update(sample).digest('hex');
  const allowed = { [digest]: 'Synthetic public identifier for this test only' };
  assert.deepEqual(scanContent(sample, 'public.ts', allowed), []);
  assert.equal(scanContent(sample + 'x', 'public.ts', allowed).length, 1);
});

test('blocks credential/export names even when forced into Git, while templates stay usable', () => {
  for (const path of ['.env', 'web/.env.local', 'secrets.json', 'credentials.json',
    '.agents/openrouter.key', 'project.scatter.zip', 'capture.har', 'scatter settings.json']) {
    assert.equal(forbiddenPath(path), true, path);
    assert.equal(scanContent('not a real credential', path)[0].rule, 'Credential/export file');
  }
  for (const path of ['web/.env.example', '.env.template', 'src/secretTools.ts', 'config.json']) {
    assert.equal(forbiddenPath(path), false, path);
  }
});

function repository(run) {
  const dir = mkdtempSync(join(tmpdir(), 'scatter-secret-guard-'));
  mkdirSync(join(dir, 'web'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Secret guard test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'core.hooksPath', join(root, '.githooks')]);
  try { run({ dir, git }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the real commit hook rejects a staged credential and accepts its removal', () => repository(({ dir, git }) => {
  const sample = samples[2][1];
  writeFileSync(join(dir, 'web/test.ts'), 'const key = "' + sample + '";\n');
  git(['add', 'web/test.ts']);
  const blocked = spawnSync('git', ['commit', '-m', 'fixture'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Secret check blocked/);
  assert.ok(!(blocked.stdout + blocked.stderr).includes(sample));
  writeFileSync(join(dir, 'web/test.ts'), 'const key = process.env.TEST_KEY;\n');
  git(['add', 'web/test.ts']);
  git(['commit', '-qm', 'safe fixture']);
  assert.ok(git(['rev-parse', 'HEAD']));
}));

test('staging a credential file is blocked even when the content has no recognized token', () => repository(({ dir, git }) => {
  writeFileSync(join(dir, 'credentials.json'), '{}');
  git(['add', '-f', 'credentials.json']);
  const blocked = spawnSync(process.execPath, [cli, '--staged'], { cwd: dir, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Credential\/export file/);
}));

test('the push check catches an old key even after the file was removed in a newer commit', () => repository(({ dir, git }) => {
  const sample = samples[2][1];
  writeFileSync(join(dir, 'web/test.ts'), sample);
  git(['add', 'web/test.ts']);
  // Only this isolated synthetic history intentionally bypasses the guard.
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'synthetic key fixture']);
  git(['rm', '-q', 'web/test.ts']);
  git(['commit', '-qm', 'remove synthetic fixture']);
  const tip = git(['rev-parse', 'HEAD']);
  const checked = spawnSync(process.execPath, [cli, '--pre-push'], {
    cwd: dir, encoding: 'utf8', input: 'refs/heads/test ' + tip + ' refs/heads/test ' + '0'.repeat(40) + '\n',
  });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /OpenRouter key/);
  assert.ok(!(checked.stdout + checked.stderr).includes(sample));
}));

test('deleting a remote branch requires no outgoing-history scan', () => repository(({ dir }) => {
  const checked = spawnSync(process.execPath, [cli, '--pre-push'], {
    cwd: dir, encoding: 'utf8', input: '(delete) ' + '0'.repeat(40) + ' refs/heads/test ' + 'a'.repeat(40) + '\n',
  });
  assert.equal(checked.status, 0);
}));

test('installed hooks survive switching to an older checkout without guard scripts', () => repository(({ dir, git }) => {
  writeFileSync(join(dir, 'README.md'), 'Initial safe content');
  git(['add', 'README.md']); git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  for (const folder of ['scripts', '.githooks']) mkdirSync(join(dir, folder));
  for (const file of ['scripts/check-secrets.mjs', 'scripts/secret-scan.config.json',
    'scripts/install-git-hooks.mjs', 'scripts/publication-policy.mjs', '.githooks/pre-commit', '.githooks/pre-push']) {
    copyFileSync(join(root, file), join(dir, file));
  }
  git(['add', 'scripts', '.githooks']); git(['commit', '-qm', 'guard sources']);
  git(['config', '--unset', 'core.hooksPath']);
  execFileSync(process.execPath, [join(dir, 'scripts/install-git-hooks.mjs')], { cwd: dir });
  git(['checkout', '-q', '--detach', base]);
  writeFileSync(join(dir, 'web/test.ts'), samples[2][1]); git(['add', 'web/test.ts']);
  const blocked = spawnSync('git', ['commit', '-m', 'synthetic fixture'], { cwd: dir, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Secret check blocked/);
  assert.ok(!blocked.stderr.includes(samples[2][1]));
}));
