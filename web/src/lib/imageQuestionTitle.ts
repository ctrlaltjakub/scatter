import type { ScatterNode } from '@/store/types';

export const IMAGE_TITLE_PLACEHOLDER = 'Generating';

export function isImageTitlePending(node: ScatterNode | undefined): boolean {
  if (!node?.generating) return false;
  return (node.generatingVersionIndex == null || node.generatingVersionIndex === node.currentVersionIndex)
    && node.versions[node.currentVersionIndex]?.imageTitleState === 'pending';
}

export function imageQuestionTitleInput(question: string, answer: string): string {
  return JSON.stringify({ question: question.slice(0, 2_000), imageAwareAnswer: answer.replace(/\[\[([^\]]+)\]\]/g, '$1').slice(0, 6_000) });
}

export function cleanImageQuestionTitle(raw: string): string | null {
  const title = raw.trim().replace(/^['"“”]+|['"“”]+$/g, '').replace(/[\r\n]+/g, ' ').trim();
  if (!title || title.length > 120 || title.split(/\s+/).length > 12 || /[{}<>]|```/.test(title)) return null;
  return title;
}

/** ASCII labels reserve all three dots; only paint changes, not placement. */
export function generatingTitleDotVisible(index: number, total: number, now: number): boolean {
  return index < total - 3 || index - (total - 3) < 1 + Math.floor(now / 400) % 3;
}
