import { describe, expect, it } from 'vitest';
import type { DiagnosticResult } from './modelDiagnostics';
import { diagnosticCounts, diagnosticResultsMarkdown } from './modelDiagnosticResults';

const sample: DiagnosticResult = { key: 'private-internal-key', role: 'main', model: 'example/model', provider: 'Local provider',
  label: 'Encyclopedic generation', status: 'failed', code: 'invalid_structure', detail: 'Missing sections. Restore the system prompt and retry.', milliseconds: 2345 };

describe('model diagnostic Markdown reports', () => {
  it('includes role, model, provider, outcome, duration, failure code and remedy', () => {
    const text = diagnosticResultsMarkdown({ results: [sample], timeoutSeconds: 30, startedAt: 0, copiedAt: 1000 });
    expect(text).toContain('# Model capability test results');
    expect(text).toContain('- Latest run started: 1970-01-01T00:00:00.000Z');
    expect(text).toContain('- Copied: 1970-01-01T00:00:01.000Z');
    expect(text).toContain('- Timeout per check: 30 seconds');
    expect(text).toContain('## Main model');
    expect(text).toContain('### Encyclopedic generation');
    expect(text).toContain('- Result: **Failed**');
    expect(text).toContain('- Model: example/model');
    expect(text).toContain('- Provider: Local provider');
    expect(text).toContain('- Duration: 2.3 seconds');
    expect(text).toContain('- Diagnostic code: invalid\\_structure');
    expect(text).toContain('Restore the system prompt and retry');
    expect(text).not.toContain(sample.key);
    expect(text).not.toContain('Partial report');
  });
  it('includes all outcome types and marks partial or stale results explicitly', () => {
    const statuses: DiagnosticResult['status'][] = ['running', 'passed', 'failed', 'inconclusive', 'skipped', 'cancelled'];
    const results = statuses.map((status, index) => ({ ...sample, key: String(index), status, role: index === 0 ? 'main' as const : 'secondary' as const }));
    expect(diagnosticCounts(results)).toEqual({ running: 1, passed: 1, failed: 1, inconclusive: 1, skipped: 1, cancelled: 1 });
    const text = diagnosticResultsMarkdown({ results, timeoutSeconds: 180, stale: true, error: 'Session stopped', copiedAt: 0 });
    expect(text).toContain('**Partial report:**');
    expect(text).toContain('**Settings changed:**');
    expect(text).toContain('**Session error:** Session stopped');
    expect(text).toContain('1 running, 1 passed, 1 failed, 1 inconclusive, 1 skipped, 1 cancelled');
    expect(text).toContain('## Secondary tasks');
  });
  it('escapes provider text so it cannot become Markdown formatting, links, or HTML', () => {
    const text = diagnosticResultsMarkdown({ results: [{ ...sample, label: '# test\nnext', provider: '<b>Provider</b>',
      detail: '![image](https://example.test/pixel)\n## injected heading\n<script>bad()</script>' }], timeoutSeconds: 180, copiedAt: 0 });
    expect(text).toContain('### \\# test next');
    expect(text).toContain('\\<b\\>Provider\\</b\\>');
    expect(text).not.toContain('![image](');
    expect(text).not.toContain('\n## injected heading');
    expect(text).not.toContain('<script>');
  });
  it('handles an empty session without inventing completed checks or start times', () => {
    const text = diagnosticResultsMarkdown({ results: [], timeoutSeconds: 30, copiedAt: 0 });
    expect(text).toContain('0 checks; none.');
    expect(text).not.toContain('Latest run started');
    expect(text).not.toContain('## Main model');
  });
});
