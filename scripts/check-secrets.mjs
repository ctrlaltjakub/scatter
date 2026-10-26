#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isPrivatePath, validatePush, checkPublicationHistory } from './publication-policy.mjs';

const config = JSON.parse(readFileSync(new URL('./secret-scan.config.json', import.meta.url), 'utf8'));
const rules = [
  ['OpenAI project key', /sk-proj-[A-Za-z0-9_-]{30,}/g],
  ['OpenAI legacy key', /sk-[A-Za-z0-9]{40,}/g],
  ['OpenRouter key', /sk-or-v1-[A-Za-z0-9_-]{30,}/g],
  ['Anthropic key', /sk-ant-(?:usr-|api03-)?[A-Za-z0-9_-]{30,}/g],
  ['Google API key', /AIza[A-Za-z0-9_-]{30,}/g],
  ['Gemini authorization key', /AQ\.[A-Za-z0-9_-]{30,}/g],
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['Vercel token', /vcp_[A-Za-z0-9_]{24,}/g],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
];

export function forbiddenPath(path) {
  const name = path.replaceAll('\\', '/').split('/').at(-1);
  if (/^\.env(?:\.|$)/i.test(name) && !/^\.env\.(?:example|template)$/i.test(name)) return true;
  return /\.(?:key|pem|p12|pfx|har|scatter\.zip)$/i.test(name)
    || /^(?:credentials|secrets)(?:[.-].*)?\.json$/i.test(name)
    || /^scatter[ -]settings.*\.json$/i.test(name);
}

/** Findings deliberately contain no matched value or source-line excerpt. */
export function scanContent(data, path, allowedFingerprints = config.allowedFingerprints) {
  const text = Buffer.isBuffer(data) ? data.toString('latin1') : data;
  const findings = forbiddenPath(path) ? [{ path, line: 1, rule: 'Credential/export file' }] : [];
  for (const [rule, expression] of rules) {
    for (const match of text.matchAll(expression)) {
      const digest = createHash('sha256').update(match[0]).digest('hex');
      if (Object.hasOwn(allowedFingerprints, digest)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({ path, line, rule });
    }
  }
  return findings;
}

function git(args, options = {}) {
  return execFileSync('git', args, { maxBuffer: 128 * 1024 * 1024, ...options });
}

async function history(refs) {
  const listing = git(['rev-list', '--objects', ...refs], { encoding: 'utf8' });
  const objects = new Map(listing.trim().split('\n').filter(Boolean).map(line => [
    line.slice(0, 40), line.length > 41 ? line.slice(41) : '(commit metadata)',
  ]));
  const child = spawn('git', ['cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('git cat-file failed')));
  });
  child.stdin.end([...objects.keys()].join('\n') + '\n');
  let buffer = Buffer.alloc(0), current = null, count = 0;
  const findings = [];
  for await (const chunk of child.stdout) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (true) {
      if (!current) {
        const end = buffer.indexOf(10);
        if (end < 0) break;
        const [oid, type, size] = buffer.subarray(0, end).toString().split(' ');
        if (!/^\d+$/.test(size)) throw new Error('Could not read a Git object');
        current = { oid, type, size: Number(size) };
        buffer = buffer.subarray(end + 1);
      }
      if (buffer.length < current.size + 1) break;
      if (['blob', 'commit', 'tag'].includes(current.type)) {
        const path = current.type === 'blob' ? objects.get(current.oid) : '(commit metadata)';
        findings.push(...scanContent(buffer.subarray(0, current.size), path)
          .map(item => ({ ...item, object: current.oid })));
        count++;
      }
      buffer = buffer.subarray(current.size + 1);
      current = null;
    }
  }
  await completion;
  if (current || buffer.length) throw new Error('Incomplete Git object stream');
  return { findings, count };
}

async function main() {
  const [mode, ...refs] = process.argv.slice(2);
  let result;
  if (mode === '--staged') {
    const paths = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z']).toString().split('\0').filter(Boolean);
    result = { count: paths.length, findings: paths.flatMap(path => [
      ...(isPrivatePath(path) ? [{ path, line: 1, rule: 'Private/unapproved workspace file' }] : []),
      ...scanContent(git(['show', ':' + path]), path),
    ]) };
  } else if (mode === '--pre-push') {
    const pushInput = readFileSync(0, 'utf8');
    validatePush(pushInput, process.env.SCATTER_APPROVED_STABLE_COMMIT);
    const tips = [...new Set(pushInput.trim().split('\n')
      .map(line => line.split(/\s+/)[1]).filter(sha => sha && !/^0+$/.test(sha)))];
    if (!tips.length) return;
    checkPublicationHistory(tips);
    // Scan the complete outgoing histories, including an old branch somebody
    // might otherwise reintroduce after a sensitive-data history rewrite.
    result = await history(tips);
  } else if (mode === '--history') {
    checkPublicationHistory(refs.length ? refs : ['--all']);
    result = await history(refs.length ? refs : ['--all']);
  } else {
    throw new Error('Usage: check-secrets.mjs --staged | --pre-push | --history [Git refs]');
  }
  for (const item of result.findings) {
    console.error(item.path + ':' + item.line + ': ' + item.rule
      + (item.object ? ' (object ' + item.object.slice(0, 12) + ')' : ''));
  }
  if (result.findings.length) {
    console.error('Secret check blocked this operation. Remove credentials from the staged files/history; use local ignored files. No secret values are printed.');
    process.exitCode = 1;
  } else {
    console.log('Secret check passed (' + result.count + ' files/objects scanned).');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('Secret check failed: ' + error.message); process.exitCode = 1; });
}
