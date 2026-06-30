/**
 * HeroConstellation - a lightweight, premium animated graph-motif backdrop for
 * the landing hero. Pure inline SVG + CSS (Tailwind keyframes); NO canvas, NO
 * WebGL, NO external deps, NO network. It is purely decorative, so it is marked
 * `aria-hidden` and every animation is gated behind `motion-safe:` so
 * `prefers-reduced-motion` users get a calm static composition.
 *
 * The motif echoes the product: nodes connected by edges, in the brand CYAN.
 * Edges "draw in" once on load (stroke-dashoffset) and nodes gently breathe
 * (twinkle). Rendered as a server component - it ships zero client JS.
 */

interface Node {
  id: string;
  x: number;
  y: number;
  r: number;
  /** 0 = brand cyan, 1 = violet, 2 = emerald - just for tasteful variety. */
  hue: 0 | 1 | 2;
  /** animation-delay (seconds) so nodes don't pulse in lockstep. */
  delay: number;
}

// A hand-tuned constellation. Coordinates are in a 1000x1000 viewBox so the
// backdrop scales cleanly behind any hero size.
const NODES: Node[] = [
  { id: 'hub', x: 500, y: 460, r: 16, hue: 0, delay: 0 },
  { id: 'a', x: 250, y: 230, r: 9, hue: 1, delay: 0.6 },
  { id: 'b', x: 760, y: 250, r: 10, hue: 2, delay: 1.1 },
  { id: 'c', x: 180, y: 600, r: 8, hue: 0, delay: 1.7 },
  { id: 'd', x: 820, y: 620, r: 9, hue: 1, delay: 0.9 },
  { id: 'e', x: 470, y: 800, r: 8, hue: 2, delay: 2.1 },
  { id: 'f', x: 360, y: 420, r: 6, hue: 0, delay: 1.4 },
  { id: 'g', x: 650, y: 560, r: 7, hue: 0, delay: 0.3 },
  { id: 'h', x: 110, y: 360, r: 5, hue: 2, delay: 2.5 },
  { id: 'i', x: 900, y: 420, r: 5, hue: 1, delay: 1.9 },
];

const NODE_BY_ID = new Map(NODES.map((n) => [n.id, n]));

const EDGES: Array<[string, string]> = [
  ['hub', 'a'],
  ['hub', 'b'],
  ['hub', 'c'],
  ['hub', 'd'],
  ['hub', 'e'],
  ['hub', 'f'],
  ['hub', 'g'],
  ['a', 'f'],
  ['a', 'h'],
  ['b', 'i'],
  ['b', 'g'],
  ['c', 'e'],
  ['d', 'g'],
  ['d', 'i'],
];

const HUE_FILL = ['url(#hc-cyan)', 'url(#hc-violet)', 'url(#hc-emerald)'];

export function HeroConstellation() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1000 1000"
      preserveAspectRatio="xMidYMid slice"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <defs>
        <radialGradient id="hc-cyan" cx="50%" cy="35%" r="70%">
          <stop offset="0%" stopColor="rgb(var(--accent-300))" />
          <stop offset="100%" stopColor="rgb(var(--accent-600))" />
        </radialGradient>
        <radialGradient id="hc-violet" cx="50%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#c4b5fd" />
          <stop offset="100%" stopColor="#7c3aed" />
        </radialGradient>
        <radialGradient id="hc-emerald" cx="50%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#6ee7b7" />
          <stop offset="100%" stopColor="#059669" />
        </radialGradient>
        <linearGradient id="hc-edge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="rgb(var(--accent-400))" stopOpacity="0.55" />
          <stop offset="100%" stopColor="rgb(var(--accent-700))" stopOpacity="0.12" />
        </linearGradient>
      </defs>

      {/* Edges: each path "draws in" once via stroke-dashoffset (1 -> 0 over a
          normalized pathLength of 1). Staggered by index so the graph assembles. */}
      <g stroke="url(#hc-edge)" strokeWidth="1.4" fill="none" strokeLinecap="round">
        {EDGES.map(([from, to], i) => {
          const a = NODE_BY_ID.get(from)!;
          const b = NODE_BY_ID.get(to)!;
          return (
            <line
              key={`${from}-${to}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              pathLength={1}
              strokeDasharray={1}
              className="motion-safe:animate-draw-line"
              style={{ animationDelay: `${0.15 * i}s` }}
            />
          );
        })}
      </g>

      {/* Nodes: a soft outer halo + a crisp core, gently breathing (twinkle). */}
      {NODES.map((n) => (
        <g
          key={n.id}
          className="motion-safe:animate-twinkle"
          style={{ animationDelay: `${n.delay}s`, transformOrigin: `${n.x}px ${n.y}px` }}
        >
          <circle cx={n.x} cy={n.y} r={n.r * 2.4} fill={HUE_FILL[n.hue]} opacity="0.12" />
          <circle cx={n.x} cy={n.y} r={n.r} fill={HUE_FILL[n.hue]} />
        </g>
      ))}
    </svg>
  );
}
