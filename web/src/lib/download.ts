/**
 * Shared "save a file to the user's disk" helpers — used by the text editor's
 * .md/.docx export and the Settings project export.
 */

/** Squash a title into a safe filename base (never empty — falls back). */
export function sanitizeFilename(title: string, fallback = 'scatter-note'): string {
  return title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || fallback;
}

/** Trigger a browser download of `blob` as `name` via a throwaway link. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
