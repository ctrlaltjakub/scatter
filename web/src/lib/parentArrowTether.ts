type Point = { x: number; y: number };
type Follower = Point & { vx: number; vy: number };
type Curve = readonly [Point, Point, Point, Point];
const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// Presentation only. Track the grip and two parts of the shaft in screen
// pixels so camera movement/zoom alone doesn't manufacture a sideways kick.
export function createTetherMotion(start: Point) {
  const follower = (): Follower => ({ ...start, vx: 0, vy: 0 });
  return { grip: { ...start }, near: follower(), far: follower() };
}
type Motion = ReturnType<typeof createTetherMotion>;

// Exact critically damped spring for a fixed target over this frame.
function follow(s: Follower, target: Point, dt: number, tau: number) {
  const decay = Math.exp(-dt / tau);
  const dx = s.x - target.x, dy = s.y - target.y;
  const jx = s.vx + dx / tau, jy = s.vy + dy / tau;
  s.x = target.x + (dx + jx * dt) * decay; s.y = target.y + (dy + jy * dt) * decay;
  s.vx = (s.vx - jx * dt / tau) * decay; s.vy = (s.vy - jy * dt / tau) * decay;
}

export function stepTetherMotion(m: Motion, pointer: Point, elapsedMs: number) {
  const dt = Math.max(0, elapsedMs), gain = -Math.expm1(-dt / 36);
  m.grip.x += (pointer.x - m.grip.x) * gain; m.grip.y += (pointer.y - m.grip.y) * gain;
  follow(m.near, pointer, dt, 46);
  follow(m.far, pointer, dt, 76);
}

export function tetherCurve(m: Motion, start: Point, end: Point, zoom: number): Curve {
  const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
  if (!length) return [start, start, end, end];
  const nx = -dy / length, ny = dx / length;
  const limit = Math.min(100, length * zoom * .36);
  const handle = (t: number, follower: Point, weight: number) => {
    const drag = ((follower.x - m.grip.x) * nx + (follower.y - m.grip.y) * ny) * weight;
    const offset = limit * Math.tanh(drag / limit) / zoom;
    return { x: start.x + t * dx + nx * offset, y: start.y + t * dy + ny * offset };
  };
  // Only lateral motion bends the rope. Pulling it taut cannot make it loop
  // back on itself, even when the cursor crosses the child at high speed.
  return [start, handle(1 / 3, m.near, 1), handle(2 / 3, m.far, .48), end];
}

const xy = (p: Point) => `${p.x} ${p.y}`;
// Split a cubic at t; the two pieces trace exactly the same curve.
function split([a, b, c, d]: Curve, t: number): [Curve, Curve] {
  const ab = mix(a, b, t), bc = mix(b, c, t), cd = mix(c, d, t);
  const left = mix(ab, bc, t), right = mix(bc, cd, t), join = mix(left, right, t);
  return [[a, ab, left, join], [join, right, cd, d]];
}

/** During release blend the saved rope (including its bends) into the
 * moving curve. After release only one cubic is needed, at any zoom. */
export function tetherPath(curve: Curve, original: readonly Point[], progress: number): string {
  if (progress >= 1) return `M ${xy(curve[0])} C ${xy(curve[1])}, ${xy(curve[2])}, ${xy(curve[3])}`;
  let tail = curve, d = 'M ' + xy(mix(original[0]!, curve[0], progress));
  for (let i = 1; i < original.length; i += 3) {
    let piece = tail;
    if (i + 3 < original.length) [piece, tail] = split(tail, 3 / (original.length - i));
    d += ' C ' + xy(mix(original[i]!, piece[1], progress)) + ', ' + xy(mix(original[i + 1]!, piece[2], progress))
      + ', ' + xy(mix(original[i + 2]!, piece[3], progress));
  }
  return d;
}
