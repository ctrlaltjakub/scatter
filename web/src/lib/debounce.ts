export type Debounced<F extends (...args: unknown[]) => void> = F & {
  cancel: () => void;
};

export function debounce<F extends (...args: unknown[]) => void>(fn: F, ms: number): Debounced<F> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const debounced = ((...args: unknown[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  }) as Debounced<F>;
  debounced.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  return debounced;
}
