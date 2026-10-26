import type { ChatQuestionReference } from '@/store/chatTypes';
import type { ScatterNode } from '@/store/types';
import type { NodeTextSelection } from '@/store/useNodeTextSelectionStore';

/** Selection is transient until Send captures it on the new answer. Never
 * persist a stale selection as an unsent draft, or include user messages. */
export function chatSelectionReference(node: ScatterNode | undefined, selection: NodeTextSelection | null): ChatQuestionReference | undefined {
  if (!node?.chat || selection?.nodeId !== node.id || !selection.text.trim()) return;
  const answer = node.versions[selection.versionIndex];
  if (!answer?.chat || answer.body !== selection.sourceBody) return;
  return { turnId: answer.chat.turnId, versionCreatedAt: answer.createdAt,
    title: selection.text.replace(/\s+/gu, ' ').trim(), selectedText: selection.text };
}
