import { configuredPrompt } from '@/lib/configuredPrompt';
import { DEFAULT_PROMPTS } from './promptDefaults';
import type { Project } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { secondaryTaskCompletion } from './secondaryTaskCompletion';
import { completeGenGroupTitle } from '@/store/bgGen';
import { newId } from './ids';
import { FAILED_GROUP_TITLE, GENERATING_GROUP_TITLE } from './groupTitle';
import { useSettingsStore } from '@/store/useSettingsStore';
import { generationLanguagePrompt } from './generationLanguage';

export const SELECTION_GROUP_NAME_SYSTEM = DEFAULT_PROMPTS.groupName;

export function selectionHeaders(project: Project, ids: readonly string[]): string[] {
  return ids.map((id) => {
    const node = project.nodes[id];
    return node?.versions[node.currentVersionIndex]?.header.trim() ?? '';
  });
}

/** A selected common ancestor, not simply the earliest-created node. Walk
 * structural parents only; visual references never establish ancestry. */
export function selectedCommonAncestor(project: Project, ids: readonly string[]): string | null {
  const selected = new Set(ids.filter((id) => project.nodes[id]));
  if (!selected.size) return null;
  const parents = new Map<string, string[]>();
  for (const arrow of Object.values(project.arrows)) {
    if (arrow.kind !== 'auto') continue;
    const list = parents.get(arrow.toNodeId) ?? [];
    list.push(arrow.fromNodeId);
    parents.set(arrow.toNodeId, list);
  }
  let candidates = new Set(selected);
  for (const id of selected) {
    const ancestors = new Set<string>();
    const pending = [id];
    while (pending.length) {
      const current = pending.pop()!;
      if (ancestors.has(current)) continue;
      ancestors.add(current);
      pending.push(...(parents.get(current) ?? []));
    }
    candidates = new Set([...candidates].filter((candidate) => ancestors.has(candidate)));
    if (!candidates.size) return null;
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function parseSelectionGroupName(raw: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('The model did not return a valid group name. Try again.'); }
  const value = parsed && typeof parsed === 'object' && 'name' in parsed ? parsed.name : null;
  if (typeof value !== 'string') throw new Error('The model did not return a group name. Try again.');
  const name = value.trim().replace(/\s+/g, ' ');
  const compactCjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{L}\p{N}ー]{2,16}$/u.test(name)
    && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name);
  if (name.length > 100 || (!compactCjk && ![2, 3].includes(name.split(' ').length))
    || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} '\u2019-]*$/u.test(name)) {
    throw new Error('The model did not return a short, valid group name. Try again.');
  }
  return name;
}

/** Create + assign immediately in one undo step. The task is owned by the
 * captured group, not by the toolbar's selection or React lifetime. */
export function createGroupFromSelection(ids: readonly string[]): string | null {
  const project = useGraphStore.getState().project;
  if (!project || !ids.some(id => id !== project.rootNodeId && project.nodes[id])) return null;
  const headers = selectionHeaders(project, ids);
  const ancestor = selectedCommonAncestor(project, ids);
  const ancestorName = ancestor ? selectionHeaders(project, [ancestor])[0] : '';
  if (ancestorName) return useGraphStore.getState().createGroupFromNodes(ids, ancestorName);
  const requestId = newId();
  const groupId = useGraphStore.getState().createGroupFromNodes(ids, GENERATING_GROUP_TITLE, { id: requestId, headers });
  void (async () => {
    try {
      const name = parseSelectionGroupName(await secondaryTaskCompletion({
        system: configuredPrompt('groupName') + '\n\n' + generationLanguagePrompt(useSettingsStore.getState().generationLanguage), user: JSON.stringify({ headers }),
        maxOutputTokens: 256, rejectTruncated: true, signal: AbortSignal.timeout(90_000),
      }));
      completeGenGroupTitle(project.id, groupId, requestId, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not generate a title.';
      completeGenGroupTitle(project.id, groupId, requestId, FAILED_GROUP_TITLE, message);
    }
  })();
  return groupId;
}
