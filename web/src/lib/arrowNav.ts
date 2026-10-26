/**
 * Pick the arrow end whose header should identify the relation.
 *
 * The child is the useful destination in normal use. Once the child is fully
 * visible and its parent has left the screen entirely, the parent becomes the
 * useful destination instead. Both ASCII labels and arrow clicks use this
 * function so the visual promise and navigation can never drift apart.
 */
export function resolveArrowLabelEnd(args: {
  childFullyVisible: boolean;
  parentPartiallyVisible: boolean;
}): 'child' | 'parent' {
  return args.childFullyVisible && !args.parentPartiallyVisible ? 'parent' : 'child';
}
