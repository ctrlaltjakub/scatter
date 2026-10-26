import type { ArrowSourceSelection } from '@/store/types';
import type { NodeTextSelection } from '@/store/useNodeTextSelectionStore';
import { sourceFieldProjection } from './nodeTextSelection';

export interface ResolvedSourceSelectionPart {
  sourceField: string;
  displayStart: number;
  displayEnd: number;
  text: string;
}

export interface ResolvedArrowSourceSelection {
  text: string;
  createdAt: number;
  parts: ResolvedSourceSelectionPart[];
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function createArrowSourceSelection(
  selection: NodeTextSelection,
  sourceVersionCreatedAt: number,
  createdAt = Date.now(),
): ArrowSourceSelection | null {
  const parts = selection.parts?.filter((part) => (
    !!part.sourceField
    && part.end > part.start
    && !!normalize(part.text)
  ));
  if (!parts?.length || parts.length !== selection.parts?.length) return null;

  const text = normalize(selection.text);
  if (!text) return null;
  return {
    sourceVersionCreatedAt,
    createdAt,
    text,
    parts: parts.map((part) => ({ ...part, text: normalize(part.text) })),
  };
}

function exactVersionRange(
  rawOffsets: readonly number[],
  start: number,
  end: number,
): { displayStart: number; displayEnd: number } | null {
  const displayStart = rawOffsets.findIndex((raw) => raw >= start && raw < end);
  if (displayStart < 0) return null;
  let displayEnd = displayStart + 1;
  while (displayEnd < rawOffsets.length && rawOffsets[displayEnd]! < end) displayEnd += 1;
  return { displayStart, displayEnd };
}

function uniqueDisplayRange(text: string, needle: string): {
  displayStart: number;
  displayEnd: number;
} | null {
  const first = text.indexOf(needle);
  if (first < 0 || text.indexOf(needle, first + 1) >= 0) return null;
  return { displayStart: first, displayEnd: first + needle.length };
}

export function resolveArrowSourceSelection(
  body: string,
  currentVersionCreatedAt: number,
  anchor: ArrowSourceSelection | null | undefined,
): ResolvedArrowSourceSelection | null {
  if (!anchor?.parts.length) return null;
  const exactVersion = currentVersionCreatedAt === anchor.sourceVersionCreatedAt;
  const parts: ResolvedSourceSelectionPart[] = [];

  for (const part of anchor.parts) {
    const projection = sourceFieldProjection(body, part.sourceField);
    if (!projection) return null;
    const range = exactVersion
      ? exactVersionRange(projection.raw, part.start, part.end)
      : uniqueDisplayRange(projection.text, part.text);
    if (!range) return null;
    const resolvedText = projection.text.slice(range.displayStart, range.displayEnd);
    if (normalize(resolvedText) !== part.text) return null;
    parts.push({ sourceField: part.sourceField, ...range, text: resolvedText });
  }

  return { text: anchor.text, createdAt: anchor.createdAt, parts };
}
