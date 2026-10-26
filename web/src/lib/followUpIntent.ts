export type FollowUpIntent = 'explore' | 'explain' | 'chat';

/** Unambiguous output-format requests need no model decision. Everything else
 * uses the editable classifier, including requests in other languages. */
export function explicitFollowUpIntent(question: string): FollowUpIntent | undefined {
  const match = question.match(/\b(?:use|create|make|give me|open|spawn|answer in|respond in|as|in|into)\s+(?:me\s+)?(?:an?\s+)?(encyclopedic|encyclopedia|explain|explanation|chat)\s+node\b/i);
  if (!match || /\b(?:not|never|don't|do not)\b[^.!?;]*$/i.test(question.slice(0, match.index))) return;
  return /^(?:encyclopedic|encyclopedia)$/i.test(match[1]!) ? 'explore' : /^chat$/i.test(match[1]!) ? 'chat' : 'explain';
}
