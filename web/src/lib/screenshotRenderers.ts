/** Capture-only adapters. No project/settings persistence and no undo entries. */
type CanvasRenderer = (pixelRatio: number) => string | Promise<string>;
const renderers = new WeakMap<HTMLCanvasElement, CanvasRenderer>();
export function registerScreenshotRenderer(canvas: HTMLCanvasElement, render: CanvasRenderer): () => void {
  renderers.set(canvas, render);
  return () => { renderers.delete(canvas); };
}
export function screenshotRenderer(canvas: HTMLCanvasElement): CanvasRenderer | undefined {
  return renderers.get(canvas);
}
