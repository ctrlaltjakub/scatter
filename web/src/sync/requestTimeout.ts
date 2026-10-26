/** Covers response headers AND body consumption. Large project/media transfers
 * get more time than connection checks and directory listings. Never retry a
 * timed-out write automatically: the server may already have committed it. */
export function syncRequestSignal(init: RequestInit, downloadingFile = false): AbortSignal {
  const timeout = AbortSignal.timeout(init.body instanceof Blob || downloadingFile ? 300_000 : 60_000);
  return init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
}

export function isSyncTimeout(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'name' in cause
    && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
}

export function syncFailureMessage(cause: unknown): string {
  if (isSyncTimeout(cause)) {
    return 'The sync request did not finish in time. Check your connection and try again.';
  }
  return cause instanceof Error ? cause.message : String(cause);
}
