/** Shared by the app document and opaque interactive iframes. Keep this
 * function self-contained: the sandbox injects its serialized source. */
export function installClickFlash(
  doc: Document,
  timers?: { setTimeout: (callback: () => void, delay: number) => number; clearTimeout: (id: number) => void },
): () => void {
  const win = doc.defaultView!;
  const schedule = timers?.setTimeout ?? win.setTimeout.bind(win);
  const cancel = timers?.clearTimeout ?? win.clearTimeout.bind(win);
  const root = doc.documentElement;
  let timer: number | null = null;
  const clear = () => {
    root.classList.remove('sc-pressing', 'sc-disabled-pressing');
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (!target?.closest) return;
    // Clear the previous flash before reading the real cursor on a rapid
    // second press (for example moving from a button to a text input).
    clear();
    const disabled = target.closest(':disabled, [disabled], [aria-disabled="true"]');
    const cursor = win.getComputedStyle(target).cursor;
    const fallback = cursor.slice(cursor.lastIndexOf(',') + 1).trim();
    if (!disabled && fallback !== 'pointer' && fallback !== 'default') return;
    root.classList.add(disabled ? 'sc-disabled-pressing' : 'sc-pressing');
    timer = schedule(clear, 150);
  };
  doc.addEventListener('pointerdown', onPointerDown, true);
  win.addEventListener('blur', clear);
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    win.removeEventListener('blur', clear);
    clear();
  };
}
