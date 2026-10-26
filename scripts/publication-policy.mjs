import { execFileSync } from 'node:child_process';

const roots = new Set(['web', 'scripts', '.githooks', '.github', 'assets']);
const files = new Set(['.gitignore', 'README.md', 'LICENSE.md', 'CONTRIBUTING.md', 'SECURITY.md']);

export function isPrivatePath(path) {
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.length === 1 && !files.has(path)) return true;
  if (parts.length > 1 && !roots.has(parts[0])) return true;
  if (parts.some(part => /^(?:AGENTS?\.md|\.agents|\.codex|\.claude|\.vercel|prototypes|recordings|test-results|playwright-report|node_modules|\.next(?:[.-].*)?|example_projects?|exports|\.private)$/i.test(part))) return true;
  if (/\.(?:har|trace\.zip|scatter\.zip)$/i.test(path)) return true;
  return /^assets\/(?!readme\/)/.test(path);
}

export function validatePush(lines, approvedStableCommit = '') {
  for (const line of lines.trim().split('\n').filter(Boolean)) {
    const [, localSha, remoteRef] = line.split(/\s+/);
    if (/^refs\/heads\/(?:main|master)$/.test(remoteRef) && localSha !== approvedStableCommit) {
      throw new Error('Stable push blocked. Ordinary development is beta-only. A stable release needs explicit approval and SCATTER_APPROVED_STABLE_COMMIT set to the exact approved commit.');
    }
  }
}

/** Inspect every tree, not only the latest snapshot: removed private files must not leak in history. */
export function checkPublicationHistory(refs) {
  const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const trees = new Set(git(['log', '--format=%T', ...refs]).trim().split('\n').filter(Boolean));
  const violations = new Set();
  for (const tree of trees) {
    for (const path of git(['ls-tree', '-r', '--name-only', '-z', tree]).split('\0').filter(Boolean)) {
      if (isPrivatePath(path)) violations.add(path);
    }
  }
  if (violations.size) throw new Error('Private or unapproved paths in outgoing history:\n' + [...violations].join('\n'));
}
