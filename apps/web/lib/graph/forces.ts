/**
 * Dependency-free d3-style positioning forces for the graph canvas.
 *
 * `react-force-graph` (via `force-graph`) registers only `link`, `charge` and
 * `center` forces by default, so `d3Force('x')` / `d3Force('y')` return
 * `undefined` and any "centre gravity" slider bound to them is a dead control.
 * Rather than pull in the whole `d3-force` package, we re-implement the tiny
 * slice we need: a per-axis positioning force equivalent to `d3.forceX(target)`
 * / `d3.forceY(target)` with a tunable strength.
 *
 * A d3 force is just a callable invoked each simulation tick with the current
 * `alpha`, plus an `initialize(nodes)` hook the simulation calls when the node
 * set changes. Each tick we nudge every (non-pinned) node's velocity on the
 * chosen axis toward `target`, scaled by `strength * alpha` — exactly what
 * d3-force's positioning forces do.
 *
 * Kept framework-free and unit-tested so the canvas component stays a thin
 * presentational shell.
 */

/** The minimal node shape a positioning force reads / mutates. */
export interface ForceNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

/** A d3-compatible force: callable per tick, with `initialize` + `strength`. */
export interface PositioningForce {
  (alpha: number): void;
  initialize: (nodes: ForceNode[]) => void;
  strength: (value: number) => PositioningForce;
}

/**
 * Create a positioning force that pulls nodes toward `target` on the given
 * axis. Equivalent to `d3.forceX(target)` / `d3.forceY(target)`.
 */
export function makePositioningForce(axis: 'x' | 'y', target = 0): PositioningForce {
  let nodes: ForceNode[] = [];
  let strengthValue = 0;
  const velKey = axis === 'x' ? 'vx' : 'vy';
  const fixedKey = axis === 'x' ? 'fx' : 'fy';

  const force = ((alpha: number) => {
    if (strengthValue === 0) return;
    const k = strengthValue * alpha;
    for (const node of nodes) {
      // Pinned nodes (fx/fy set) ignore positioning forces, matching d3.
      const fixed = node[fixedKey];
      if (fixed !== undefined && fixed !== null) continue;
      const pos = node[axis];
      if (pos === undefined) continue;
      node[velKey] = (node[velKey] ?? 0) + (target - pos) * k;
    }
  }) as PositioningForce;

  force.initialize = (n: ForceNode[]) => {
    nodes = n;
  };
  force.strength = (value: number) => {
    strengthValue = value;
    return force;
  };
  return force;
}
