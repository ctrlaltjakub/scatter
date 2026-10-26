/** Keep the jump target and visible-turn detector aligned. */
export const CHAT_SCROLL_INSET = 14;

export function visibleChatTurn(scroll: HTMLElement, zoom: number, atBottom: boolean): HTMLElement | null {
  const turns = [...scroll.querySelectorAll<HTMLElement>('[data-chat-turn]')];
  if (atBottom) return turns.at(-1) ?? null;
  const anchor = scroll.getBoundingClientRect().top + CHAT_SCROLL_INSET * zoom;
  return turns.find((turn) => turn.getBoundingClientRect().bottom > anchor + 1) ?? null;
}
