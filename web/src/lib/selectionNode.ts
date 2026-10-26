/**
 * Map a text selection to the single node it lives in.
 *
 * The smart-selection toolbar (copy / check / explain) only makes sense when a
 * selection is entirely inside ONE node's body — its actions spawn a child of
 * that node. Selection endpoints are usually Text nodes, so we climb to the
 * nearest Element, then to the closest ancestor carrying `data-node-id` (the
 * `.node` card root, set in NodeView). Both endpoints must resolve to the same
 * id; otherwise (cross-node or outside any node) the toolbar must not appear.
 */

/** Closest ancestor element (including self) that carries `data-node-id`. */
function closestNodeEl(n: Node | null): Element | null {
  let el: Node | null = n;
  while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
  return (el as Element | null)?.closest('[data-node-id]') ?? null;
}

/** The node id shared by both selection endpoints, or null if they aren't both
 *  inside the same node. */
export function selectionNodeId(anchor: Node | null, focus: Node | null): string | null {
  const a = closestNodeEl(anchor);
  const b = closestNodeEl(focus);
  if (!a || !b) return null;
  const idA = a.getAttribute('data-node-id');
  const idB = b.getAttribute('data-node-id');
  if (!idA || idA !== idB) return null;
  return idA;
}
