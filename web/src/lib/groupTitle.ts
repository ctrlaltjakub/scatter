import type { Group } from '@/store/types';

export const GENERATING_GROUP_TITLE = 'Generating title';
export const FAILED_GROUP_TITLE = 'Untitled group';

export function isGroupTitleGenerating(group: Group): boolean {
  return !!group.titleGeneration && !group.titleGeneration.error;
}

/** Persist a recoverable label rather than a spinner that cannot survive a
 * closed tab or crash. The live in-memory request keeps its original state. */
export function recoverGroupTitle(group: Group): Group {
  return isGroupTitleGenerating(group) ? { ...group, name: FAILED_GROUP_TITLE,
    titleGeneration: { ...group.titleGeneration!, error: 'Title generation was interrupted.' },
  } : group;
}
