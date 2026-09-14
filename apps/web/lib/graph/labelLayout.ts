/**
 * Pure label-declutter algorithm for the graph canvas.
 *
 * The canvas renderer used to decide per-node whether to draw a label purely
 * from a zoom threshold (`shouldShowLabel` in `physics.ts`), with zero
 * awareness of what other labels were already drawn this frame. In any
 * moderately dense neighbourhood that means every eligible label gets drawn
 * regardless of overlap, so labels stack on top of each other and become
 * unreadable - the single biggest "the graph looks like garbage" complaint.
 *
 * This module fixes that with a simple greedy placement pass, run once per
 * frame (see `ForceGraphCanvas`'s `onRenderFramePre`):
 *
 *   1. "Forced" candidates (selected / hovered / focused-neighbourhood /
 *      search-matched nodes) always get a label and reserve their bounding
 *      box first, regardless of any overlap with each other - the user
 *      explicitly focused this neighbourhood, so every label in it must show.
 *   2. Remaining candidates are sorted by priority (default: node degree,
 *      highest first) and placed one at a time; a candidate is skipped if its
 *      label's axis-aligned bounding box would overlap any box already
 *      placed this frame.
 *
 * Deliberately a simple O(n^2) axis-aligned rect scan against a small running
 * list of placed boxes - no spatial index. At the node counts labels are ever
 * actually drawn for (a few hundred at most; large graphs are already gated
 * by the zoom threshold before a node is even a candidate) this is cheap
 * enough to run every animation frame.
 *
 * Framework-free and DOM-free: text measurement is injected via
 * `measureTextWidth` so this is unit-testable without a canvas, and reusable
 * for a non-canvas renderer later.
 */

/** One node's label placement request for the current frame. */
export interface LabelCandidate {
  id: string;
  /** World-space centre position (pre-zoom-transform; matches node x/y). */
  x: number;
  y: number;
  /** Node radius in the same world-space units as x/y. */
  radius: number;
  /** The label text to place. */
  text: string;
  /**
   * Always shown regardless of overlap with other forced labels (selected /
   * hovered / focused-neighbourhood / search match). Forced candidates are
   * placed first and never skipped.
   */
  forced: boolean;
  /**
   * Placement priority among non-forced candidates - higher goes first.
   * Ties keep input order (stable sort). Typically the node's degree so hubs
   * win contested space over leaves.
   */
  priority: number;
}

/** An axis-aligned bounding box in the same world-space units as x/y. */
export interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** True when two axis-aligned boxes overlap (touching edges do not count). */
export function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * The bounding box a label occupies. Mirrors the canvas draw call in
 * `ForceGraphCanvas` (`textAlign: 'center'`, `textBaseline: 'top'`, drawn at
 * `(x, y + radius + 1)`) so placement decisions match what is actually
 * rendered. `pad` adds a small visual gap so adjacent labels never touch.
 */
export function labelBox(
  candidate: Pick<LabelCandidate, 'x' | 'y' | 'radius'>,
  textWidth: number,
  fontSize: number,
  pad: number,
): LabelBox {
  const halfWidth = textWidth / 2;
  const top = candidate.y + candidate.radius + 1;
  return {
    x0: candidate.x - halfWidth - pad,
    x1: candidate.x + halfWidth + pad,
    y0: top - pad,
    // textBaseline 'top': the glyph box extends downward from the draw point.
    // 1.3x the nominal font size comfortably covers ascenders/descenders
    // across the sans-serif stack this app uses.
    y1: top + fontSize * 1.3 + pad,
  };
}

/**
 * Greedy label declutter for one frame. Returns the set of candidate ids
 * whose label should be drawn.
 *
 * @param candidates    every node currently eligible to be considered.
 * @param fontSize      the (uniform, per-frame) label font size in the same
 *                       world-space units as `x`/`y`/`radius`.
 * @param measureTextWidth injected text measurer, e.g.
 *                       `(text, fontSize) => ctx.measureText(text).width`
 *                       after `ctx.font` is set. Kept injectable so this stays
 *                       canvas-free and unit-testable.
 * @param pad           extra world-space gap kept between placed label boxes.
 */
export function selectVisibleLabels(
  candidates: readonly LabelCandidate[],
  fontSize: number,
  measureTextWidth: (text: string, fontSize: number) => number,
  pad = 1.5,
): Set<string> {
  const visible = new Set<string>();
  const placed: LabelBox[] = [];

  const forced = candidates.filter((c) => c.forced);
  const rest = candidates
    .filter((c) => !c.forced)
    .slice()
    .sort((a, b) => b.priority - a.priority);

  for (const c of forced) {
    visible.add(c.id);
    placed.push(labelBox(c, measureTextWidth(c.text, fontSize), fontSize, pad));
  }

  for (const c of rest) {
    const box = labelBox(c, measureTextWidth(c.text, fontSize), fontSize, pad);
    if (placed.some((p) => boxesOverlap(p, box))) continue;
    visible.add(c.id);
    placed.push(box);
  }

  return visible;
}
