import type { ProviderConversationMessage, StreamChatOpts } from '@/providers/types';
import type { InteractivePlan } from '@/lib/interactiveWorkflow';

export const INTERACTIVE_PLAN_FIXTURE: InteractivePlan = {
  purpose: 'A counter with reset and an upper boundary.', layout: 'Visible #count, #add and #reset within 960×720.', assumptions: [],
  scenarios: [
    { kind: 'initial', name: 'Starts at zero', actions: [], assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: '0' }] },
    { kind: 'normal', name: 'Adds one', actions: [{ selector: '#add', action: 'click' }], assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: '1' }] },
    { kind: 'boundary', name: 'Stops at one', actions: [{ selector: '#add', action: 'click' }, { selector: '#add', action: 'click' }], assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: '1' }] },
    { kind: 'reset', name: 'Resets changed state', actions: [{ selector: '#add', action: 'click' }, { selector: '#reset', action: 'click' }], assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: '0' }] },
  ],
};
export const INTERACTIVE_REVIEW_FIXTURE = { ok: true, summary: 'Visible controls and outcomes match the request.', issues: [] };
export const INTERACTIVE_SCREENSHOT_FIXTURE = 'data:image/png;base64,fixture';

export function interactiveMetaResponse(options: StreamChatOpts | ProviderConversationMessage[]): string | undefined {
  const messages = Array.isArray(options) ? options : options.conversation ?? [];
  if (messages.some(message => message.images?.length)) return JSON.stringify(INTERACTIVE_REVIEW_FIXTURE);
  if (messages.at(-1)?.content.startsWith('Plan the program before implementation.')) return JSON.stringify(INTERACTIVE_PLAN_FIXTURE);
}
