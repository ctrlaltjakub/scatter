export interface PortPoint { x: number; y: number }

/** A node-local attachment boundary. Only image-region arrows supply one. */
export interface SourcePort {
  center: PortPoint;
  contours: PortPoint[][];
  /** Separate selection islands; the nearest one owns the outgoing arrow. */
  components?: SourcePort[];
}

export function closestPointOnPort(port: SourcePort, point: PortPoint): PortPoint {
  let closest = port.center, distance = Infinity;
  for (const contour of port.contours) for (let i = 0; i < contour.length; i++) {
    const a = contour[i]!, b = contour[(i + 1) % contour.length]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const candidate = { x: a.x + t * dx, y: a.y + t * dy };
    const d = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
    if (d < distance) { closest = candidate; distance = d; }
  }
  return closest;
}

export function sourcePortForTarget(port: SourcePort, node: PortPoint, target: PortPoint): SourcePort {
  if (!port.components?.length) return port;
  const local = { x: target.x - node.x, y: target.y - node.y };
  let best = port.components[0]!, distance = Infinity;
  for (const component of port.components) {
    const point = closestPointOnPort(component, local);
    const d = (point.x - local.x) ** 2 + (point.y - local.y) ** 2;
    if (d < distance) { best = component; distance = d; }
  }
  return best;
}

export function sourcePortCenter(port: SourcePort, node: PortPoint, target?: PortPoint): PortPoint {
  if (target) port = sourcePortForTarget(port, node, target);
  return { x: node.x + port.center.x, y: node.y + port.center.y };
}

/** Intersect the ray with the actual rounded frame, not its bounding box.
 * Taking the final crossing also avoids running through a second selected part. */
export function sourcePortToward(port: SourcePort, node: PortPoint, target: PortPoint): PortPoint {
  port = sourcePortForTarget(port, node, target);
  const center = port.center;
  let dx = target.x - node.x - center.x;
  const dy = target.y - node.y - center.y;
  if (Math.abs(dx) + Math.abs(dy) < 1e-9) dx = 1;
  let farthest = 0;
  for (const contour of port.contours) {
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i]!, b = contour[(i + 1) % contour.length]!;
      const ex = b.x - a.x, ey = b.y - a.y;
      const cross = dx * ey - dy * ex;
      if (Math.abs(cross) < 1e-9) continue;
      const ax = a.x - center.x, ay = a.y - center.y;
      const t = (ax * ey - ay * ex) / cross;
      const u = (ax * dy - ay * dx) / cross;
      if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9) farthest = Math.max(farthest, t);
    }
  }
  return { x: node.x + center.x + dx * farthest, y: node.y + center.y + dy * farthest };
}
