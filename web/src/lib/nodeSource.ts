import type { NodeVersion } from '@/store/types';
import { answerBodyToDoc, answerDocToBody } from './answerEditorSerialize';
import { withExportBibliography } from './exportSources';
import { stripChips } from './bulletParse';

/** Snapshot only this version/answer. Use the export serializer so removing
 * term marks cannot corrupt adjacent emphasis, tables, code or citations. */
export function nodeSourceSnapshot(version: NodeVersion): { title: string; text: string } {
  const title = stripChips((version.contentType === 'answer' ? version.header : version.chat?.title) || version.header).trim() || 'Node text';
  const body = answerDocToBody(answerBodyToDoc(version.body), { stripTerms: true });
  return { title, text: withExportBibliography(`# ${title}\n\n${body}`, version) };
}

export async function addNodeVersionToSources(projectId: string, version: NodeVersion): Promise<void> {
  if (!projectId || !version.body.trim()) throw new Error('This version has no text to add.');
  // Capture before asynchronous importing, even if the user switches projects
  // or answers. Reuse source publication/removal, not canvas undo history.
  const snapshot = nodeSourceSnapshot(version);
  const { addPastedSource, waitForProjectSources } = await import('./sourceProcessing');
  const { useSourceRuntimeStore } = await import('@/store/useSourceRuntimeStore');
  const jobId = await addPastedSource(projectId, snapshot.title, snapshot.text);
  await waitForProjectSources(projectId, [jobId]);
  const job = useSourceRuntimeStore.getState().jobs[jobId];
  if (job?.status === 'failed') throw new Error(`${job.error || 'Source import failed.'} Open Sources to retry the import.`);
}
