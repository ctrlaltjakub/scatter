import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let top;
try { top = git(['rev-parse', '--show-toplevel']); } catch { /* Deployment without Git metadata. */ }
if (top === root) {
  const common = resolve(root, git(['rev-parse', '--git-common-dir']));
  // Keep installed guards outside the checkout so switching to an old branch
  // without these scripts cannot silently disable commit/push protection.
  const installed = resolve(common, 'scatter-secret-guard');
  const destination = resolve(installed, 'hooks');
  let existing = '';
  try { existing = git(['config', '--get', 'core.hooksPath']); } catch { /* Default Git hooks directory. */ }
  const directory = existing ? resolve(root, existing) : resolve(common, 'hooks');
  const managed = [destination, resolve(root, '.githooks')].includes(directory);
  const custom = !managed && existsSync(directory)
    && readdirSync(directory).some(name => !name.endsWith('.sample') && !name.startsWith('.'));
  if (custom) {
    console.error('Existing Git hooks detected at ' + directory + '. Integrate .githooks/pre-commit and .githooks/pre-push with those hooks before committing.');
    process.exitCode = 1;
  } else {
    mkdirSync(destination, { recursive: true });
    mkdirSync(resolve(installed, 'scripts'), { recursive: true });
    for (const name of ['check-secrets.mjs', 'secret-scan.config.json', 'publication-policy.mjs']) {
      copyFileSync(resolve(root, 'scripts', name), resolve(installed, 'scripts', name));
    }
    for (const name of ['pre-commit', 'pre-push']) {
      const hook = resolve(destination, name);
      copyFileSync(resolve(root, '.githooks', name), hook);
      chmodSync(hook, 0o755);
    }
    git(['config', '--local', 'core.hooksPath', destination]);
    console.log('Installed repository secret checks for commits and pushes.');
  }
}
