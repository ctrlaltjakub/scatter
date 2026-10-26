/** Stable non-cryptographic fingerprint. Not an integrity/security check. */
export function stringHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = (((hash << 5) + hash) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}
