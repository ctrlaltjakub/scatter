import { currentContentType, isExplainContentType, stripExplainHeaderSuffix } from './nodeContentType';
import type { Arrow, HeaderParts, ImageGenerationProvenance, NodeVersion, ScatterNode } from '@/store/types';

/** Header text stays complete in storage. Card components decide how much can
 * be displayed from their actual rendered width, rather than persisting a
 * pre-truncated title that could later leak into an AI prompt. */
export function normalizeEditableHeader(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const cleanPrefix = (value?: string): string | undefined => {
  const clean = normalizeEditableHeader(value ?? '').replace(/:+$/, '').trim();
  return clean || undefined;
};

const cleanSuffix = (value?: string): string | undefined => {
  const clean = normalizeEditableHeader(value ?? '').replace(/^[\s:\-–—]+/, '').trim();
  return clean || undefined;
};

export function normalizeHeaderParts(parts: HeaderParts): HeaderParts {
  return {
    ...(cleanPrefix(parts.prefix) ? { prefix: cleanPrefix(parts.prefix) } : {}),
    subject: normalizeEditableHeader(parts.subject),
    ...(normalizeEditableHeader(parts.question ?? '')
      ? { question: normalizeEditableHeader(parts.question ?? '') }
      : {}),
    ...(cleanSuffix(parts.suffix) ? { suffix: cleanSuffix(parts.suffix) } : {}),
  };
}

/** Flatten structured parts for legacy consumers and persisted `header`. */
export function flattenHeaderParts(raw: HeaderParts): string {
  const parts = normalizeHeaderParts(raw);
  const prefix = parts.prefix ? `${parts.prefix}: ` : '';
  const question = parts.question ? `: ${parts.question}` : '';
  const suffix = parts.suffix ? ` - ${parts.suffix}` : '';
  return `${prefix}${parts.subject}${question}${suffix}`.trim();
}

/** Prompt text deliberately excludes visual-only prefix/suffix add-ons. */
export function semanticHeaderText(raw: HeaderParts): string {
  const parts = normalizeHeaderParts(raw);
  return `${parts.subject}${parts.question ? `: ${parts.question}` : ''}`.trim();
}

/** Number of fields the structured editor currently renders. Empty optional
 * drafts still count until saved because their editing row remains visible. */
export function structuredHeaderPartCount(raw: HeaderParts): number {
  return 1 + [raw.prefix, raw.question, raw.suffix]
    .filter((part) => part !== undefined).length;
}

/** Label an editor generation action from the semantic fields that will
 * actually reach the model, in their visible top-to-bottom order. */
export function regenerateFromHeaderLabel(raw: HeaderParts): string {
  if (structuredHeaderPartCount(raw) === 1) return 'Regenerate from header';
  const parts = normalizeHeaderParts(raw);
  const fields = [
    parts.subject ? 'subject' : null,
    parts.question ? 'question' : null,
  ].filter((field): field is string => field !== null);
  return fields.length ? `Regenerate from ${fields.join(' and ')}` : 'Regenerate';
}

export function plainHeaderParts(subject: string): HeaderParts {
  return { subject: normalizeEditableHeader(subject) };
}

export function imageHeaderParts(subject: string): HeaderParts {
  return { prefix: 'Image', subject: normalizeEditableHeader(subject) };
}

function clipped(value: string, length: number): string {
  if (value.length <= length) return value;
  if (length <= 1) return '…';
  const prefix = value.slice(0, length - 1);
  const boundary = prefix.lastIndexOf(' ');
  const cut = boundary > 0 ? prefix.slice(0, boundary) : prefix;
  return `${cut.trimEnd()}…`;
}

/** Find the longest header accepted by a layout predicate. Subject text gives
 * way first; the question is shortened only when the rest still cannot fit. */
export function fitHeaderParts(
  raw: HeaderParts,
  fits: (candidate: HeaderParts) => boolean,
): HeaderParts {
  const parts = normalizeHeaderParts(raw);
  if (fits(parts)) return parts;
  const maximize = (field: 'subject' | 'question', base: HeaderParts): HeaderParts => {
    const source = parts[field] ?? '';
    let lo = 0;
    let hi = source.length;
    let best = { ...base, [field]: source ? '…' : undefined } as HeaderParts;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const value = clipped(source, mid);
      const candidate = { ...base, [field]: value || undefined } as HeaderParts;
      if (fits(candidate)) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };
  let next = maximize('subject', { ...parts, subject: '' });
  if (!fits(next) && parts.question) next = maximize('question', { ...next, question: '' });
  return next;
}

/** Complete compatibility label for generated-image versions. Card rendering
 * applies the responsive three-line presentation cap at runtime. */
export function imageDisplayHeader(subject: string): string {
  return flattenHeaderParts(imageHeaderParts(subject));
}

function incomingArrow(nodeId: string, arrows: Record<string, Arrow>): Arrow | undefined {
  return Object.values(arrows).find((arrow) => arrow.kind === 'auto' && arrow.toNodeId === nodeId);
}

function completeImageSubject(
  provenance: ImageGenerationProvenance,
  incoming: Arrow | undefined,
): string | null {
  if (provenance.promptSource === 'selected-text') {
    return incoming?.sourceSelection?.text ?? null;
  }
  if (provenance.promptSource === 'media-prompt') return provenance.prompt;
  return null;
}

function partsForVersion(
  node: ScatterNode,
  version: NodeVersion,
  incoming: Arrow | undefined,
): HeaderParts {
  if (version.headerParts) return normalizeHeaderParts(version.headerParts);
  if (version.contentType === 'interactive') return plainHeaderParts(version.header);

  // Legacy manual titles are exact. Generation metadata may be left over from
  // the version they were cloned from, so never reconstruct a different title
  // from it. The explicit Explain suffix is safe to split because flattening
  // these parts produces the very same saved string.
  if (version.generatedBy === 'manual') {
    const explainSuffix = version.header.match(/\s-\s+(explained)\s*$/i)?.[1];
    if (isExplainContentType(currentContentType(node)) && explainSuffix) {
      return normalizeHeaderParts({
        subject: stripExplainHeaderSuffix(version.header),
        suffix: explainSuffix,
      });
    }
    return plainHeaderParts(version.header);
  }

  if (version.imageGeneration) {
    const subject = completeImageSubject(version.imageGeneration, incoming);
    if (subject) return imageHeaderParts(subject);
  }

  const selection = incoming?.sourceSelection?.text;
  const question = version.selectedTextQuestion;
  if (selection && question) {
    return normalizeHeaderParts({
      subject: selection,
      question,
      ...(isExplainContentType(currentContentType(node)) ? { suffix: 'explained' } : {}),
    });
  }

  if (isExplainContentType(currentContentType(node))) {
    return normalizeHeaderParts({
      subject: stripExplainHeaderSuffix(version.header),
      suffix: 'explained',
    });
  }
  return plainHeaderParts(version.header);
}

export function resolveNodeHeaderParts(
  node: ScatterNode,
  arrows: Record<string, Arrow>,
): HeaderParts {
  const version = node.versions[node.currentVersionIndex];
  if (!version) return { subject: '' };
  return partsForVersion(node, version, incomingArrow(node.id, arrows));
}

/** Question/suffix headers retain their separate fields in the full editor.
 * Media's decorative "Image:" prefix is still a single editable title. */
export function canInlineEditNodeHeader(node: ScatterNode, arrows: Record<string, Arrow>, resolvedParts?: HeaderParts): boolean {
  if (node.chat) return true;
  const parts = resolvedParts ?? resolveNodeHeaderParts(node, arrows);
  return !parts.question && !parts.suffix && (!parts.prefix
    || (currentContentType(node) === 'media' && parts.prefix === 'Image'));
}

export function resolveVersionHeaderParts(
  node: ScatterNode,
  version: NodeVersion,
  arrows: Record<string, Arrow>,
): HeaderParts {
  return partsForVersion(node, version, incomingArrow(node.id, arrows));
}

/** Return the complete editable title. Manual header versions are always exact
 * and therefore never reconstructed from older generation metadata. */
export function editableNodeHeader(
  node: ScatterNode,
  arrows: Record<string, Arrow>,
): string {
  return flattenHeaderParts(resolveNodeHeaderParts(node, arrows));
}

/** Complete presentation source for the card. NodeHeader performs the dynamic
 * visual fit while retaining this value as its accessible name. */
export function displayNodeHeader(
  node: ScatterNode,
  arrows: Record<string, Arrow>,
): string {
  return flattenHeaderParts(resolveNodeHeaderParts(node, arrows));
}
