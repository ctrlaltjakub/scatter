import type { Group } from '@/store/types';

/** Shared by sidebar rows and group menus. CSS animates just the dots, so
 * progress never rewrites the project or fills undo/autosave with ticks. */
export function GroupTitleText({ name, generation }: { name: string; generation?: Group['titleGeneration'] }) {
  const pending = !!generation && !generation.error;
  return <span aria-busy={pending || undefined}
    title={generation?.error ? `Title generation failed: ${generation.error} You can rename this group.` : undefined}>
    {name}{pending && <span className="group-title-dots" aria-hidden="true">...</span>}
  </span>;
}
