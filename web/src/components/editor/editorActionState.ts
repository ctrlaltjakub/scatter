import type { ContentType } from '@/lib/nodeContentType';

export function outlineLevelToolsDisabled(
  contentType: ContentType,
  editorReady: boolean,
  streaming: boolean,
): boolean {
  return !editorReady || streaming || contentType === 'explain' || contentType === 'interactive';
}
