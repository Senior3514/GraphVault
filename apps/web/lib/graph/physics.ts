/**
 * Pure physics + label-visibility state for the graph view.
 *
 * The force simulation is driven by a handful of tunables (link distance,
 * charge/repel strength, centre gravity) plus a label-visibility zoom
 * threshold. Keeping the defaults and the clamping logic here - framework-free
 * and unit-tested - lets the canvas component stay a thin presentational shell
 * that just applies these values to `d3Force(...)`.
 */

/** Live tunables for the force simulation and label visibility. */
export interface GraphPhysics {
  /** Target distance between linked nodes (d3 link force). */
  linkDistance: number;
  /** Many-body charge strength; more negative = stronger repulsion. */
  chargeStrength: number;
  /** Centre gravity (x/y positioning force strength); 0 = none. */
  centerGravity: number;
  /**
   * Zoom scale at/above which non-focused labels fade in. Lower = labels show
   * sooner; higher = the graph stays cleaner until you zoom in.
   */
  labelThreshold: number;
}

/** Sensible, settled defaults tuned to read clearly without drifting. */
export const DEFAULT_PHYSICS: GraphPhysics = {
  linkDistance: 60,
  chargeStrength: -160,
  centerGravity: 0.05,
  labelThreshold: 1.6,
};

/** Inclusive [min, max] bounds for each tunable, shared by sliders + clamp. */
export const PHYSICS_BOUNDS = {
  linkDistance: { min: 10, max: 200, step: 5 },
  chargeStrength: { min: -600, max: -20, step: 10 },
  centerGravity: { min: 0, max: 0.4, step: 0.01 },
  labelThreshold: { min: 0.2, max: 4, step: 0.1 },
} as const;

function clampValue(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Clamp a partial physics update into the valid ranges, merging onto a base. */
export function clampPhysics(base: GraphPhysics, patch: Partial<GraphPhysics>): GraphPhysics {
  const next = { ...base, ...patch };
  return {
    linkDistance: clampValue(
      next.linkDistance,
      PHYSICS_BOUNDS.linkDistance.min,
      PHYSICS_BOUNDS.linkDistance.max,
    ),
    chargeStrength: clampValue(
      next.chargeStrength,
      PHYSICS_BOUNDS.chargeStrength.min,
      PHYSICS_BOUNDS.chargeStrength.max,
    ),
    centerGravity: clampValue(
      next.centerGravity,
      PHYSICS_BOUNDS.centerGravity.min,
      PHYSICS_BOUNDS.centerGravity.max,
    ),
    labelThreshold: clampValue(
      next.labelThreshold,
      PHYSICS_BOUNDS.labelThreshold.min,
      PHYSICS_BOUNDS.labelThreshold.max,
    ),
  };
}

/**
 * Radius for a node given its degree. Hubs grow on a square-root curve so a
 * few very-high-degree nodes don't dwarf everything, but still read as hubs.
 */
export function radiusForDegree(degree: number): number {
  return 3 + Math.min(7, Math.sqrt(degree));
}

/**
 * Decide whether a node's label should be drawn. Always shown for the selected
 * node and its neighbours (the "focus" set); otherwise only once the zoom scale
 * crosses the label threshold.
 */
export function shouldShowLabel(opts: {
  globalScale: number;
  threshold: number;
  isFocused: boolean;
}): boolean {
  if (opts.isFocused) return true;
  return opts.globalScale >= opts.threshold;
}
