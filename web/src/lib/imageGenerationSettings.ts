/** GPT Image 2 flexible-size constraints. Kept pure so the settings form and
 * request path enforce exactly the same limits before any paid API call. */
export function validCustomImageSize(width: number, height: number): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width % 16 !== 0 || height % 16 !== 0) return false;
  if (width > 3840 || height > 3840 || width <= 0 || height <= 0) return false;
  const ratio = width / height;
  const pixels = width * height;
  return ratio >= 1 / 3 && ratio <= 3 && pixels >= 655_360 && pixels <= 8_294_400;
}
