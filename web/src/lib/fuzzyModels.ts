/** One searchable model row. Keeping provider/name/id separate prevents a
 * fuzzy matcher from treating an unrelated long row as one approximate hit. */
export interface ModelSearchFields {
  provider: string;
  id: string;
  name?: string;
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]!;
  }
  return previous[b.length]!;
}

function tokenScore(queryToken: string, words: readonly string[], combined: string): number | null {
  if (words.includes(queryToken)) return 0;
  if (words.some((word) => word.startsWith(queryToken))) return 2;
  if (combined.includes(queryToken)) return 4;
  if (queryToken.length < 3) return null;

  let best = Number.POSITIVE_INFINITY;
  for (const word of words) {
    if (word.length < 3) continue;
    const distance = editDistance(queryToken, word);
    const allowance = Math.max(1, Math.floor(Math.max(queryToken.length, word.length) * 0.28));
    if (distance <= allowance) best = Math.min(best, 8 + distance);
  }
  return Number.isFinite(best) ? best : null;
}

/** Token-aware, typo-tolerant search for provider model rows. Every query token
 * must match. Exact/prefix/substring matches outrank fuzzy matches, while equal
 * rows use their normal provider/model alphabetical order. */
export function searchModelChoices<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => ModelSearchFields,
): T[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [...items];
  const queryTokens = normalizedQuery.split(' ').filter(Boolean);

  return items.map((item, index) => {
    const value = fields(item);
    const provider = normalize(value.provider);
    const name = normalize(value.name ?? '');
    const id = normalize(value.id);
    const combined = [provider, name, id].filter(Boolean).join(' ');
    const words = combined.split(' ').filter(Boolean);
    const fieldsInPriorityOrder = [id, name, provider].filter(Boolean);
    let score = fieldsInPriorityOrder.some((field) => field === normalizedQuery)
      ? -20
      : fieldsInPriorityOrder.some((field) => field.startsWith(normalizedQuery))
        ? -10
        : fieldsInPriorityOrder.some((field) => field.includes(normalizedQuery))
          ? -4
          : 0;
    for (const token of queryTokens) {
      const tokenResult = tokenScore(token, words, combined);
      if (tokenResult == null) return null;
      score += tokenResult;
    }
    return { item, index, score, sortKey: `${provider}\0${id}` };
  }).filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => a.score - b.score
      || a.sortKey.localeCompare(b.sortKey, undefined, { sensitivity: 'base' })
      || a.index - b.index)
    .map((row) => row.item);
}

/** Back-compatible flat-ID helper used by onboarding/provider lists. */
export function fuzzyFilterModels(models: readonly string[], query: string): string[] {
  return searchModelChoices(models, query, (id) => ({ provider: '', id }));
}
