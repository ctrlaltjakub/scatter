import type { ScatterNode } from '@/store/types';

/** The content formats a node can take. Mirrors `NodeVersion.contentType`.
 *  ('media' covers both photos and videos — we don't differentiate them here.) */
export type ContentType = 'encyclopedic' | 'explain' | 'interactive' | 'media' | 'chat' | 'answer';

export function isExplainContentType(type: ContentType): boolean {
  return type === 'explain';
}

export function isStandaloneInteractive(node: ScatterNode): boolean {
  return currentContentType(node) === 'interactive';
}

/** Default level-1 bullet cap for a fresh encyclopedic generation. Each
 *  "Expand whole" raises a node's cap by +1; Regenerate resets it back to this. */
export const DEFAULT_MAX_L1_BULLETS = 10;

const EXPLAIN_HEADER_SUFFIX_RE = /\s*-\s*explained\s*$/i;

/** Remove the visual explain suffix before using a header as the model subject. */
export function stripExplainHeaderSuffix(header: string): string {
  return header.trim().replace(EXPLAIN_HEADER_SUFFIX_RE, '').trim();
}

/** Format an automatically-generated explain header exactly once. */
export function formatExplainHeader(subject: string): string {
  const plain = stripExplainHeaderSuffix(subject);
  return `${plain} - explained`;
}

/**
 * The LIVE content type of a node = the type of its CURRENT version. This — not
 * the node-level `node.type` — is the source of truth for rendering and
 * behaviour, so switching to an older, differently-typed version makes the node
 * render and behave as that version. Falls back to `node.type` for legacy
 * versions saved before `contentType` existed.
 */
export function currentContentType(node: ScatterNode): ContentType {
  if (node.chat) return 'chat';
  const v = node.versions[node.currentVersionIndex];
  if (v?.contentType) return v.contentType;
  // Legacy fallback: derive from the node's spawn-origin type.
  if (node.type === 'media') return 'media';
  if (node.type === 'explain') return 'explain';
  if (node.type === 'interactive') return 'interactive';
  return 'encyclopedic';
}

/** The level-1 bullet cap to use for THIS node's current version (default 10). */
export function currentMaxL1Bullets(node: ScatterNode): number {
  return node.versions[node.currentVersionIndex]?.maxL1Bullets ?? DEFAULT_MAX_L1_BULLETS;
}

/** Uppercase label for the bottom-margin type tag. Root is special — it always
 *  reads "ROOT" and is never re-typed. */
export function nodeTypeLabel(node: ScatterNode, isRoot: boolean): string {
  const type = currentContentType(node);
  return isRoot ? 'ROOT' : type === 'answer' && node.versions[node.currentVersionIndex]?.markdownNote ? 'MARKDOWN TEXT' : type.toUpperCase();
}
