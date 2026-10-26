/* -------------------------------------------------------------------------
 * Deterministic project generator for the physics sandbox.
 *
 * Creates a fixed graph (root + 6 children + 18 grandchildren = 25 nodes,
 * labeled A through Y) so physics changes can be evaluated against a
 * stable reference scene. New nodes spawned in the sandbox continue the
 * alphabet (Z, AA, AB, …) for predictable naming when the user reports
 * bugs ("ropes between D and E look wrong").
 * ------------------------------------------------------------------------*/

import type { Project, ScatterNode, Arrow, NodeType } from '@/store/types';

/** A→0, B→1, …, Z→25, AA→26, AB→27, … (Excel-style). */
export function letterFromIndex(n: number): string {
  if (n < 0) return '?';
  let s = '';
  let i = n;
  while (true) {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
    if (i < 0) break;
  }
  return s;
}

/** Inverse — 'A'→0, 'Z'→25, 'AA'→26. Returns -1 for malformed input. */
export function indexFromLetter(label: string): number {
  if (!label || !/^[A-Z]+$/.test(label)) return -1;
  let n = 0;
  for (let i = 0; i < label.length; i++) {
    n = n * 26 + (label.charCodeAt(i) - 65 + 1);
  }
  return n - 1;
}

/** Find the next free letter given the current set of node headers. */
export function nextSandboxLetter(headers: string[]): string {
  let maxIdx = -1;
  for (const h of headers) {
    const idx = indexFromLetter(h);
    if (idx > maxIdx) maxIdx = idx;
  }
  return letterFromIndex(maxIdx + 1);
}

/** Placeholder body for a sandbox node — contains many [[references]] so
 *  the user has clickable chips for spawning child nodes during testing. */
export function sandboxBody(letter: string): string {
  return `Node **${letter}** is a [[placeholder]] for [[testing]] the [[physics engine]].

- **Concept**: [[idea-${letter}]] connects to several [[related]] things.
- **Themes**: [[topic-${letter}]], [[detail-${letter}]], [[example-${letter}]].
- **References**: [[link-${letter}]] points back into the [[graph]].
- Each [[node]] is a [[unit]] of [[exploration]] in the [[scatter]].
- Click any [[term-${letter}]] to spawn a new [[child node]].
- [[Sandbox]] mode keeps everything [[deterministic]] for replays.`;
}

const NODE_W = 420;
const NODE_H_EST = 240; // rough — used only for initial centering
const ROOT_RADIUS = 700;     // root → children
const CHILD_RADIUS = 360;    // children → grandchildren

/** Build the canonical sandbox project: A (root) + 6 children (B–G) +
 *  18 grandchildren (H–Y, three per child). Children fan around the
 *  root in a hexagon; each child's three grandchildren fan outward
 *  from the child along the radial direction. */
export function createSandboxProject(): Project {
  const now = Date.now();
  const nodes: Record<string, ScatterNode> = {};
  const arrows: Record<string, Arrow> = {};

  // Helper to register a node.
  const placeNode = (
    letter: string,
    x: number,
    y: number,
    type: NodeType,
    generatedBy: ScatterNode['versions'][0]['generatedBy'],
  ): ScatterNode => {
    const node: ScatterNode = {
      id: letter,
      type,
      position: { x: x - NODE_W / 2, y: y - NODE_H_EST / 2 },
      frozen: false,
      versions: [{
        header: letter,
        body: sandboxBody(letter),
        createdAt: now,
        generatedBy,
      }],
      currentVersionIndex: 0,
    };
    nodes[letter] = node;
    return node;
  };

  // Helper to register an arrow.
  const linkNodes = (fromLetter: string, toLetter: string): void => {
    const id = `arrow_${fromLetter}_${toLetter}`;
    arrows[id] = {
      id,
      fromNodeId: fromLetter,
      toNodeId: toLetter,
      kind: 'auto',
      label: toLetter,
    };
  };

  // Root A at origin.
  const ROOT = 'A';
  placeNode(ROOT, 0, 0, 'root', 'root');

  // Six children B–G around root in a hexagon, starting at 12 o'clock.
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * 2 * Math.PI - Math.PI / 2;
    const cx = Math.cos(angle) * ROOT_RADIUS;
    const cy = Math.sin(angle) * ROOT_RADIUS;
    const childLetter = letterFromIndex(1 + i); // B..G
    placeNode(childLetter, cx, cy, 'term-click', 'term-click');
    linkNodes(ROOT, childLetter);

    // Three grandchildren per child, fanned outward (±30° from radial).
    for (let j = 0; j < 3; j++) {
      const offset = (j - 1) * (Math.PI / 6);
      const gcAngle = angle + offset;
      const gx = cx + Math.cos(gcAngle) * CHILD_RADIUS;
      const gy = cy + Math.sin(gcAngle) * CHILD_RADIUS;
      const gcLetter = letterFromIndex(7 + i * 3 + j); // H..Y
      placeNode(gcLetter, gx, gy, 'term-click', 'term-click');
      linkNodes(childLetter, gcLetter);
    }
  }

  return {
    id: 'sandbox',
    name: 'Physics Sandbox',
    createdAt: now,
    updatedAt: now,
    rootNodeId: ROOT,
    nodes,
    arrows,
    groups: {},
    viewport: { x: 0, y: 0, zoom: 0.6 },
    selection: [],
  };
}
