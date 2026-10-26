import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareSelectedImageEditReferences } from './imageRegionInput';

function mockContext() {
  return { fillStyle: '', fillRect: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), fill: vi.fn(),
    clip: vi.fn(), drawImage: vi.fn() };
}
const canvases: Array<{ canvas: HTMLCanvasElement; ctx: ReturnType<typeof mockContext> }> = [];
let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> };
const source = new Blob(['original'], { type: 'image/png' });
const regions = [
  { x: .1, y: .2, width: .2, height: .4 },
  { x: .3, y: .2, width: .2, height: .2 },
];

beforeEach(() => {
  canvases.length = 0;
  bitmap = { width: 1000, height: 500, close: vi.fn() };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const ctx = mockContext();
    canvases.push({ canvas: this, ctx });
    return ctx as unknown as ReturnType<HTMLCanvasElement['getContext']>;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type) {
    callback(new Blob([`${this.width}x${this.height}`], { type }));
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('selected-image edit references', () => {
  it('decodes once and returns the full-frame mask before the detail close-up', async () => {
    const refs = await prepareSelectedImageEditReferences(source, regions);
    expect(refs).toHaveLength(2);
    expect(refs.every((ref) => ref.type === 'image/png')).toBe(true);
    expect(await Promise.all(refs.map((ref) => ref.text()))).toEqual(['1000x500', '400x200']);
    expect(createImageBitmap).toHaveBeenCalledExactlyOnceWith(source);
    expect(bitmap.close).toHaveBeenCalledOnce();
    const [mask, crop] = canvases;
    expect(mask!.ctx.rect.mock.calls).toEqual([[100, 100, 200, 200], [300, 100, 200, 100]]);
    expect(mask!.ctx.fillStyle).toBe('#fff');
    expect(mask!.ctx.drawImage).not.toHaveBeenCalled();
    expect(crop!.ctx.fillStyle).toBe('#808080');
    expect(crop!.ctx.rect.mock.calls).toEqual([[0, 0, 200, 200], [200, 0, 200, 100]]);
    expect(crop!.ctx.clip).toHaveBeenCalledOnce();
    expect(crop!.ctx.drawImage).toHaveBeenCalledWith(bitmap, 100, 100, 400, expect.closeTo(200), 0, 0, 400, 200);
    expect(crop!.ctx.clip.mock.invocationCallOrder[0]).toBeLessThan(crop!.ctx.drawImage.mock.invocationCallOrder[0]!);
  });

  it('bounds reference dimensions while keeping small selected details at their original resolution', async () => {
    bitmap.width = 8000; bitmap.height = 4000;
    const refs = await prepareSelectedImageEditReferences(source, [{ x: .25, y: .25, width: .25, height: .25 }]);
    expect(await Promise.all(refs.map((ref) => ref.text()))).toEqual(['2048x1024', '2000x1000']);
    expect(canvases[1]!.ctx.drawImage).toHaveBeenCalledWith(bitmap, 2000, 1000, 2000, 1000, 0, 0, 2000, 1000);
  });

  it('sends only a close-up when the model allows two total images', async () => {
    const refs = await prepareSelectedImageEditReferences(source, regions, undefined, 'crop');
    expect(refs).toHaveLength(1);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]!.ctx.fillStyle).toBe('#808080');
    expect(await refs[0]!.text()).toBe('400x200');
  });

  it('does not decode or allocate references for coordinate-only, empty, or invalid selections', async () => {
    expect(await prepareSelectedImageEditReferences(source, regions, undefined, 'coordinates')).toEqual([]);
    expect(await prepareSelectedImageEditReferences(source, [])).toEqual([]);
    expect(await prepareSelectedImageEditReferences(source, [{ x: NaN, y: 0, width: 1, height: 1 }])).toEqual([]);
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(canvases).toHaveLength(0);
  });

  it('clamps out-of-bounds regions and supports selections touching the image edges', async () => {
    const refs = await prepareSelectedImageEditReferences(source, [{ x: -.2, y: -.1, width: 1.4, height: 1.2 }]);
    expect(await Promise.all(refs.map((ref) => ref.text()))).toEqual(['1000x500', '1000x500']);
    expect(canvases[0]!.ctx.rect).toHaveBeenCalledWith(0, 0, 1000, 500);
    expect(canvases[1]!.ctx.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1000, 500, 0, 0, 1000, 500);
  });

  it('does not allocate oversized reference canvases and always releases the decoded source', async () => {
    bitmap.width = 10000; bitmap.height = 5000;
    await expect(prepareSelectedImageEditReferences(source, regions)).rejects.toThrow('too large');
    expect(canvases).toHaveLength(0);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('stops before decoding an already-cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(prepareSelectedImageEditReferences(source, regions, controller.signal)).rejects.toThrow();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('stops after an asynchronous export if cancelled, releasing the source without making the crop', async () => {
    const controller = new AbortController();
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce((callback) => {
      controller.abort(); callback(new Blob(['mask'], { type: 'image/png' }));
    });
    await expect(prepareSelectedImageEditReferences(source, regions, controller.signal)).rejects.toThrow();
    expect(canvases).toHaveLength(1);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('reports failed reference exports instead of sending incomplete attachments', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce((callback) => callback(null));
    await expect(prepareSelectedImageEditReferences(source, regions)).rejects.toThrow('could not export');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
