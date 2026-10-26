import { describe, expect, it, vi } from 'vitest';
import { CHAT_SCROLL_INSET, visibleChatTurn } from './scroll';

describe('chat scroll alignment', () => {
  it.each([0.5, 0.75, 1, 1.5])('recognizes a jumped turn at zoom %s without an extra scroll', (zoom) => {
    const scroll = document.createElement('div');
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 600));
    const targetTop = 100 + CHAT_SCROLL_INSET * zoom;
    for (const [index, top] of [-400, targetTop, targetTop + 600].entries()) {
      const turn = document.createElement('section'); turn.dataset.chatTurn = `turn-${index}`;
      vi.spyOn(turn, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 400, index === 0 ? targetTop - top : 600));
      scroll.append(turn);
    }
    expect(visibleChatTurn(scroll, zoom, false)?.dataset.chatTurn).toBe('turn-1');
    expect(visibleChatTurn(scroll, zoom, true)?.dataset.chatTurn).toBe('turn-2');
  });
});
