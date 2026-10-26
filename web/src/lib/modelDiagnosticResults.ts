import { DIAGNOSTIC_ROLE_LABELS, type DiagnosticResult } from './modelDiagnostics';
import type { ModelRole } from '@/store/types';

export const DIAGNOSTIC_STATUS_LABELS: Record<DiagnosticResult['status'], string> = {
  running: 'Running', passed: 'Passed', failed: 'Failed', inconclusive: 'Inconclusive', skipped: 'Skipped', cancelled: 'Cancelled',
};

export function diagnosticCounts(results: DiagnosticResult[]) {
  const counts = { running: 0, passed: 0, failed: 0, inconclusive: 0, skipped: 0, cancelled: 0 };
  for (const result of results) counts[result.status]++;
  return counts;
}

const markdownText = (text: string) => text.replace(/([\\`*_{}\[\]()<>#+.!|~\-])/g, '\\$1');
const oneLine = (text: string) => markdownText(text.replace(/\s+/g, ' ').trim());

/** Copy a snapshot of the runtime results, never provider credentials or settings. */
export function diagnosticResultsMarkdown({ results, startedAt, timeoutSeconds, stale = false, error, copiedAt = Date.now() }: {
  results: DiagnosticResult[];
  startedAt?: number;
  timeoutSeconds: number;
  stale?: boolean;
  error?: string;
  copiedAt?: number;
}): string {
  const counts = diagnosticCounts(results);
  const lines = ['# Model capability test results', '', `- Copied: ${new Date(copiedAt).toISOString()}`];
  if (startedAt !== undefined) lines.push(`- Latest run started: ${new Date(startedAt).toISOString()}`);
  lines.push(`- Timeout per check: ${timeoutSeconds} seconds`,
    `- Results: ${results.length} checks; ${Object.entries(counts).filter(([, count]) => count > 0).map(([status, count]) => `${count} ${status}`).join(', ') || 'none'}.`, '');
  if (counts.running) lines.push('**Partial report:** checks marked Running had not finished when this report was copied.', '');
  if (stale) lines.push('**Settings changed:** these results describe the previous configuration.', '');
  if (error) lines.push(`**Session error:** ${markdownText(error)}`, '');
  for (const role of Object.keys(DIAGNOSTIC_ROLE_LABELS) as ModelRole[]) {
    const roleResults = results.filter(result => result.role === role);
    if (!roleResults.length) continue;
    lines.push(`## ${DIAGNOSTIC_ROLE_LABELS[role]}`, '');
    for (const result of roleResults) {
      lines.push(`### ${oneLine(result.label)}`, '',
        `- Result: **${DIAGNOSTIC_STATUS_LABELS[result.status]}**`,
        `- Model: ${oneLine(result.model)}`,
        `- Provider: ${oneLine(result.provider)}`);
      if (result.milliseconds !== undefined) lines.push(`- Duration: ${(result.milliseconds / 1000).toFixed(1)} seconds`);
      if (result.code) lines.push(`- Diagnostic code: ${oneLine(result.code)}`);
      lines.push('', markdownText(result.detail), '');
    }
  }
  lines.push('One sample per check, with no automatic retries. A pass is not a guarantee of future output quality.', '');
  return lines.join('\n');
}
