/** Fixed-width counters keep navigation and actions in one stable row. Long
 * counts fade within their own slot; the full value stays in the tooltip and
 * accessible name, rather than pushing a chevron onto another line. */
export function VersionCounter({ current, total, noun = 'Version', showTooltip = true }: {
  current: number; total: number; noun?: string; showTooltip?: boolean;
}) {
  const label = `${noun} ${current} of ${total}`;
  return <span className="version-counter" role="group" aria-label={label} title={showTooltip ? label : undefined} data-tip={showTooltip ? label : undefined}>
    <span aria-hidden="true" className={current > 99 ? 'is-long' : undefined}>{current}</span>
    <span aria-hidden="true">/</span>
    <span aria-hidden="true" className={total > 99 ? 'is-long' : undefined}>{total}</span>
  </span>;
}
