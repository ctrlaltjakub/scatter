/**
 * Uniform-grid spatial hash for the physics broad phase.
 *
 * Items are inserted by axis-aligned bounding box; queries return every
 * item in any cell overlapping the query bbox. Items whose bbox spans
 * multiple cells get inserted into ALL of those cells — so query
 * results MAY contain duplicates and the caller is responsible for
 * dedup'ing.
 *
 * Recommended dedup pattern (avoids allocations):
 *
 *   const lastSeen = new Int32Array(N);
 *   let queryId = 0;
 *   const out: number[] = [];
 *   for (let i = 0; i < N; i++) {
 *     queryId++;
 *     out.length = 0;
 *     grid.query(qMinX, qMinY, qMaxX, qMaxY, out);
 *     for (let k = 0; k < out.length; k++) {
 *       const j = out[k]!;
 *       if (j <= i) continue;            // process each pair once
 *       if (lastSeen[j] === queryId) continue;  // dedup spans
 *       lastSeen[j] = queryId;
 *       // ... process pair (i, j) ...
 *     }
 *   }
 *
 * Cell size selection: pick cellSize ≈ the typical INSERTED-item
 * dimension. That keeps each item in 1–2 cells and most queries
 * touching ≤ 4 cells. For very large items (e.g. wide nodes 600 px
 * across) a 400 px cell still has each item span 1–2 cells; for short
 * rope segments a 100 px cell works well.
 *
 * Cell coordinates are packed into a single Map key via the layout
 *   key = ((cx + OFFSET) << 16) | (cy + OFFSET)
 * which supports cell coordinates in the range ±2^15. At cellSize=50
 * that covers world coordinates in ±1.6M px — easily enough for the
 * canvas.
 */

const COORD_OFFSET = 32768;

export class SpatialHash<T> {
  private readonly invCellSize: number;
  private cells = new Map<number, T[]>();

  constructor(cellSize: number) {
    this.invCellSize = 1 / cellSize;
  }

  clear(): void {
    this.cells.clear();
  }

  private key(cx: number, cy: number): number {
    return ((cx + COORD_OFFSET) << 16) | (cy + COORD_OFFSET);
  }

  insert(item: T, minX: number, minY: number, maxX: number, maxY: number): void {
    const inv = this.invCellSize;
    const cx0 = Math.floor(minX * inv);
    const cy0 = Math.floor(minY * inv);
    const cx1 = Math.floor(maxX * inv);
    const cy1 = Math.floor(maxY * inv);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = this.key(cx, cy);
        let bucket = this.cells.get(k);
        if (!bucket) {
          bucket = [];
          this.cells.set(k, bucket);
        }
        bucket.push(item);
      }
    }
  }

  /** Append items from cells overlapping the bbox to `out`. May contain
   *  duplicates — caller deduplicates (see class doc). Reuse `out`
   *  across queries (`out.length = 0` between calls) to avoid
   *  allocation. */
  query(minX: number, minY: number, maxX: number, maxY: number, out: T[]): T[] {
    const inv = this.invCellSize;
    const cx0 = Math.floor(minX * inv);
    const cy0 = Math.floor(minY * inv);
    const cx1 = Math.floor(maxX * inv);
    const cy1 = Math.floor(maxY * inv);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = this.cells.get(this.key(cx, cy));
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) out.push(bucket[i]!);
        }
      }
    }
    return out;
  }
}
