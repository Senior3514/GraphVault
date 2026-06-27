'use client';

/**
 * Loading placeholder shown while the heavy canvas renderer chunk
 * (`react-force-graph-2d`) is fetched and mounted.
 *
 * The force-directed renderer is `next/dynamic`-imported with `ssr: false`, so
 * on first visit to `/graph` there is a brief gap while its JS chunk downloads.
 * Rather than a dead screen (or a bare text line), we show a lightweight,
 * themed, accessible skeleton that hints at the graph that is about to appear:
 * a faint scatter of "nodes" with a gentle pulse.
 *
 * Design constraints honoured:
 * - **No layout shift:** the skeleton fills the same `h-full w-full` box the
 *   canvas will occupy, so swapping it for the real graph causes no reflow.
 * - **Motion-safe:** all animation is gated behind `motion-safe:` so users with
 *   `prefers-reduced-motion: reduce` get a calm static placeholder.
 * - **Themed:** uses the CSS-variable-driven `neutral` ramp, so it adapts to
 *   light/dark automatically (same tokens as the rest of the app).
 * - **Accessible:** the region is a polite live status with a label, so screen
 *   readers announce that the graph is loading without trapping focus.
 *
 * It imports nothing heavy (no force-graph, no engine) so it stays in the page
 * entry chunk and paints instantly - the whole point is to be visible before
 * the renderer's chunk arrives.
 */

/** Decorative node positions (percent of the box). Purely visual scaffolding. */
const SKELETON_NODES: ReadonlyArray<{ x: number; y: number; r: number; delay: number }> = [
  { x: 50, y: 48, r: 18, delay: 0 },
  { x: 32, y: 30, r: 10, delay: 120 },
  { x: 70, y: 32, r: 11, delay: 80 },
  { x: 28, y: 66, r: 9, delay: 200 },
  { x: 73, y: 68, r: 12, delay: 160 },
  { x: 50, y: 78, r: 8, delay: 240 },
  { x: 15, y: 50, r: 7, delay: 300 },
  { x: 87, y: 50, r: 7, delay: 280 },
];

/** Decorative edges connecting the central node to its neighbours. */
const SKELETON_EDGES: ReadonlyArray<[number, number]> = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [0, 5],
  [1, 6],
  [2, 7],
];

export function GraphLoadingSkeleton() {
  const center = SKELETON_NODES[0];
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading graph view"
      className="flex h-full w-full items-center justify-center bg-neutral-950"
    >
      <div className="relative h-2/3 max-h-96 w-2/3 max-w-2xl motion-safe:animate-fade-in">
        {/* Edges + nodes layer */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {SKELETON_EDGES.map(([a, b], i) => {
            const from = SKELETON_NODES[a]!;
            const to = SKELETON_NODES[b]!;
            return (
              <line
                key={i}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="rgb(var(--n-700))"
                strokeWidth={0.4}
                vectorEffect="non-scaling-stroke"
                className="motion-safe:animate-glow-pulse"
                style={{ animationDelay: `${i * 90}ms` }}
              />
            );
          })}
          {SKELETON_NODES.map((n, i) => (
            <circle
              key={i}
              cx={n.x}
              cy={n.y}
              r={n.r / 8}
              fill={i === 0 ? 'rgb(var(--n-600))' : 'rgb(var(--n-700))'}
              className="motion-safe:animate-glow-pulse"
              style={{ animationDelay: `${n.delay}ms` }}
            />
          ))}
        </svg>
        {/* Centred label below the central node */}
        <div
          className="absolute left-0 right-0 flex justify-center"
          style={{ top: `${center!.y + center!.r / 2 + 6}%` }}
        >
          <span className="rounded-md bg-neutral-900/80 px-2.5 py-1 text-xs text-neutral-400">
            Loading graph&hellip;
          </span>
        </div>
      </div>
    </div>
  );
}

export default GraphLoadingSkeleton;
