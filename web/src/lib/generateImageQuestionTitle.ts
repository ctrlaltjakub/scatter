import { configuredPrompt } from '@/lib/configuredPrompt';
import { getGenProject, updateGenNode } from '@/store/bgGen';
import { secondaryTaskCompletion } from './secondaryTaskCompletion';
import { cleanImageQuestionTitle, imageQuestionTitleInput } from './imageQuestionTitle';
import { generationLanguagePrompt } from './generationLanguage';
import { versionLanguage } from './languages';

/** Derived content belongs to the original spawn's undo step. Guard the exact
 * version/header so deletes, manual renames, retries and project switches are safe. */
export async function generateImageQuestionTitle(projectId: string, nodeId: string, versionIndex: number,
  answer: string, signal: AbortSignal): Promise<void> {
  const initial = getGenProject(projectId)?.nodes[nodeId]?.versions[versionIndex];
  if (!initial?.imageQuestion || initial.imageTitleState !== 'pending' || signal.aborted) return;
  let title: string | null = null;
  try {
    title = cleanImageQuestionTitle(await secondaryTaskCompletion({
      system: configuredPrompt('imageQuestionTitle') + '\n\n' + generationLanguagePrompt(versionLanguage(initial)),
      user: imageQuestionTitleInput(initial.imageQuestion, answer),
      maxOutputTokens: 512, rejectTruncated: true, signal,
    }));
  } catch { /* The answer remains usable even if its auxiliary title fails. */ }
  if (signal.aborted) return;
  const node = getGenProject(projectId)?.nodes[nodeId];
  versionIndex = node?.versions.findIndex(version => version.createdAt === initial.createdAt) ?? -1;
  const version = node?.versions[versionIndex];
  if (!node || !version || version.createdAt !== initial.createdAt || version.header !== initial.header
    || version.imageTitleState !== 'pending') return;
  const header = title ?? initial.imageQuestion;
  const versions = [...node.versions];
  versions[versionIndex] = { ...version, header, headerParts: { subject: header }, imageTitleState: title ? 'complete' : 'failed' };
  updateGenNode(projectId, nodeId, { versions });
}
