/** Display-only cleanup; provider requests always retain the exact model ID. */
export function modelDisplayName(id: string): string {
  return (id.split('/').pop() || id)
    // Anthropic encodes decimal versions with a hyphen in its direct API IDs.
    .replace(/^(claude-(?:haiku|sonnet|opus)-\d+)-(\d)(?=-|$)/i, '$1.$2')
    .replace(/^(claude-\d+)-(\d)(?=-(?:haiku|sonnet|opus))/i, '$1.$2')
    .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}
