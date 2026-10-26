import type { FreeImageSource } from '@/store/types';

export class ImageCatalogError extends Error {
  constructor(
    public readonly source: FreeImageSource,
    public readonly kind: 'rate-limited' | 'unavailable',
    message: string,
    public readonly retryAt?: number,
  ) {
    super(message);
    this.name = 'ImageCatalogError';
  }
}

function numericReset(value: string, now: number, relative: boolean): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  if (relative) return now + Math.max(0, numeric) * 1000;
  // Providers commonly use either Unix seconds or milliseconds.
  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
}

export function retryAtFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return date;
  }
  for (const name of ['x-ratelimit-reset', 'ratelimit-reset', 'x-rate-limit-reset']) {
    const value = headers.get(name)?.trim();
    if (!value) continue;
    const reset = numericReset(value, now, name === 'ratelimit-reset');
    if (reset != null) return reset;
  }
  return undefined;
}

export async function catalogResponseError(
  source: FreeImageSource,
  response: Response,
): Promise<ImageCatalogError> {
  const retryAt = retryAtFromHeaders(response.headers);
  const body = await response.clone().text().catch(() => '');
  const detail = body.slice(0, 240).replace(/\s+/g, ' ').trim();
  if (response.status === 429) {
    return new ImageCatalogError(
      source,
      'rate-limited',
      `${source === 'openverse' ? 'Openverse' : 'Wikimedia'} rate-limited this search.`,
      retryAt,
    );
  }
  return new ImageCatalogError(
    source,
    'unavailable',
    `${source === 'openverse' ? 'Openverse' : 'Wikimedia'} returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`,
  );
}
