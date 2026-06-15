import Link from 'next/link';

/**
 * Marketing landing page. Rendered full-bleed (no app chrome) via AppFrame.
 * The pitch: a dynamic vault you just open and write in — none of the
 * folder-picking / "grant access to all your files" friction.
 *
 * Everything is CSS/SVG: no external image fetches, no telemetry, on-brand
 * dark. Decorative motion is gated behind `motion-safe:` so it respects
 * `prefers-reduced-motion`.
 */

export default function LandingPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-neutral-950 text-neutral-100">
      {/* Ambient backdrop: a soft radial glow + faint grid, pure CSS. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_40rem_at_50%_-10%,theme(colors.sky.500/15),transparent)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.06] [background-image:linear-gradient(theme(colors.neutral.400)_1px,transparent_1px),linear-gradient(90deg,theme(colors.neutral.400)_1px,transparent_1px)] [background-size:48px_48px]"
      />

      <div className="relative">
        {/* Nav */}
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <GraphMark className="h-6 w-6 text-sky-400" />
            GraphVault
          </span>
          <nav className="flex items-center gap-5 text-sm text-neutral-400">
            <Link href="/graph" className="hidden hover:text-neutral-100 sm:block">
              Graph
            </Link>
            <a
              href="https://github.com/Senior3514/GraphVault"
              className="hidden hover:text-neutral-100 sm:block"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            <Link
              href="/vault"
              className="rounded-md bg-sky-500 px-3.5 py-1.5 font-medium text-neutral-950 transition-colors hover:bg-sky-400"
            >
              Open the app
            </Link>
          </nav>
        </header>

        {/* Hero */}
        <section className="mx-auto grid max-w-6xl gap-12 px-6 pb-12 pt-12 sm:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/60 px-3 py-1 text-xs text-neutral-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse" />
              No folders. No file permissions. No setup.
            </p>
            <h1 className="max-w-3xl text-balance text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl">
              A notes vault you just <span className="text-sky-400">open and write in</span>.
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-neutral-400">
              GraphVault is a local-first Markdown app with self-hosted sync and a graph you can
              actually think in. Open straight into your vault — no folder picker, no &quot;allow
              access to your files&quot; dialog. Start writing in seconds, then press <Kbd>⌘</Kbd>
              <Kbd>K</Kbd> to go anywhere.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/vault"
                className="rounded-md bg-sky-500 px-5 py-2.5 font-medium text-neutral-950 transition-colors hover:bg-sky-400"
              >
                Open the app →
              </Link>
              <Link
                href="/graph"
                className="rounded-md border border-neutral-800 px-5 py-2.5 font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900"
              >
                See the graph
              </Link>
            </div>
            <p className="mt-4 text-xs text-neutral-600">
              Opens in your browser. Your notes stay in your vault — export to plain Markdown
              anytime. No telemetry, ever.
            </p>
          </div>

          {/* CSS/SVG product preview: a mini graph wired to a note card. */}
          <GraphPreview />
        </section>

        {/* Three promises */}
        <section className="mx-auto max-w-6xl px-6 py-10">
          <div className="grid gap-5 sm:grid-cols-3">
            <Promise glyph="◇" title="Your files, not ours">
              Plain Markdown with <code className="text-sky-300">[[wikilinks]]</code>,{' '}
              <code className="text-sky-300">#tags</code>, and backlinks. No lock-in — it&apos;s
              just a folder of <code className="text-sky-300">.md</code> files.
            </Promise>
            <Promise glyph="⇅" title="Self-hosted sync">
              Run a small open-source server on your own VPS. Per-device tokens, conflict-aware, and
              content-addressed — it never silently loses a note.
            </Promise>
            <Promise glyph="⬡" title="A graph to think in">
              Every note and link becomes a navigable graph with filters and typed relations — a
              first-class tool, not a decorative hairball.
            </Promise>
          </div>
        </section>

        {/* Contrast strip */}
        <section className="border-y border-neutral-900 bg-neutral-900/30">
          <div className="mx-auto grid max-w-6xl gap-px px-6 py-12 sm:grid-cols-2">
            <div className="pr-8">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                The old way
              </h2>
              <ul className="mt-4 space-y-2 text-neutral-400">
                <li>Pick a folder on disk before you can do anything.</li>
                <li>Grant an app access to all your files.</li>
                <li>Wrestle with vaults, paths, and sync plugins.</li>
              </ul>
            </div>
            <div className="border-t border-neutral-800 pt-8 sm:border-l sm:border-t-0 sm:pl-8 sm:pt-0">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-sky-400">
                The GraphVault way
              </h2>
              <ul className="mt-4 space-y-2 text-neutral-200">
                <li>Open the app — your vault is already there.</li>
                <li>No file-system permissions, ever.</li>
                <li>Write, link, and explore the graph immediately.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="mx-auto max-w-6xl px-6 py-16">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <Feature title="Markdown, first-class">
              Write in plain Markdown with <code className="text-sky-300">[[wikilinks]]</code>,
              backlinks, tags, and instant full-text search. No lock-in — export anytime.
            </Feature>
            <Feature title="Command palette">
              Press <Kbd>⌘</Kbd>
              <Kbd>K</Kbd> to quick-open any note, jump between views, or run a command — keyboard
              first, beautifully fast.
            </Feature>
            <Feature title="Open and go">
              No folder picker, no &quot;allow access to your files&quot; dialog. The vault is
              dynamic and ready the moment the app loads.
            </Feature>
            <Feature title="Backlinks &amp; connections">
              See what links here as you write. Connections surface automatically, so your thinking
              compounds instead of scattering.
            </Feature>
            <Feature title="Self-hosted sync, optional">
              Want multi-device sync? Run the small open-source server on your own VPS.
              Conflict-aware and content-addressed — it never silently loses a note.
            </Feature>
            <Feature title="Security-conscious">
              TLS via a reverse proxy, hashed passwords, optional at-rest encryption, and zero
              telemetry by default. Your notes are yours.
            </Feature>
          </div>
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="rounded-2xl border border-neutral-800 bg-gradient-to-b from-neutral-900 to-neutral-950 px-8 py-14 text-center">
            <h2 className="text-3xl font-bold tracking-tight">Start writing now.</h2>
            <p className="mx-auto mt-3 max-w-xl text-neutral-400">
              No account required to try it. Open the vault, jot a thought, and watch the graph
              grow.
            </p>
            <Link
              href="/vault"
              className="mt-7 inline-block rounded-md bg-sky-500 px-6 py-3 font-medium text-neutral-950 transition-colors hover:bg-sky-400"
            >
              Open GraphVault →
            </Link>
          </div>
        </section>

        <footer className="border-t border-neutral-900">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-sm text-neutral-500 sm:flex-row">
            <span>Local-first notes. Self-hosted sync. A graph you can think in.</span>
            <a
              href="https://github.com/Senior3514/GraphVault"
              className="hover:text-neutral-300"
              target="_blank"
              rel="noreferrer"
            >
              Open source on GitHub →
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}

function Promise({
  glyph,
  title,
  children,
}: {
  glyph: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
      <span
        aria-hidden="true"
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-sky-400/30 bg-sky-500/10 text-sky-300"
      >
        {glyph}
      </span>
      <h3 className="mt-3 text-base font-semibold text-neutral-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-neutral-400">{children}</p>
    </div>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6">
      <h3 className="text-base font-semibold text-neutral-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-neutral-400">{children}</p>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 inline-block rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs font-medium text-neutral-300">
      {children}
    </kbd>
  );
}

/**
 * A self-contained product preview: a small force-graph-style node cluster
 * floating beside a faux note card. Entirely SVG + CSS, so it ships in the
 * static export with no runtime, no canvas, and no network calls.
 */
function GraphPreview() {
  return (
    <div className="relative mx-auto w-full max-w-md">
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4 shadow-2xl shadow-black/40 ring-1 ring-white/5">
        {/* Window chrome */}
        <div className="mb-3 flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
          <span className="ml-2 text-[11px] text-neutral-500">vault · graph</span>
        </div>

        <svg viewBox="0 0 320 200" className="w-full" role="img" aria-label="A small note graph">
          <defs>
            <radialGradient id="node" cx="50%" cy="35%" r="70%">
              <stop offset="0%" stopColor="#7dd3fc" />
              <stop offset="100%" stopColor="#0ea5e9" />
            </radialGradient>
          </defs>
          <g stroke="#334155" strokeWidth="1.4">
            <line x1="160" y1="100" x2="70" y2="50" />
            <line x1="160" y1="100" x2="250" y2="56" />
            <line x1="160" y1="100" x2="80" y2="150" />
            <line x1="160" y1="100" x2="246" y2="150" />
            <line x1="70" y1="50" x2="80" y2="150" />
            <line x1="250" y1="56" x2="246" y2="150" />
          </g>
          <g>
            <GraphNode cx={160} cy={100} r={13} label="Ideas" hub />
            <GraphNode cx={70} cy={50} r={9} label="Sync" />
            <GraphNode cx={250} cy={56} r={9} label="Graph" />
            <GraphNode cx={80} cy={150} r={9} label="Notes" />
            <GraphNode cx={246} cy={150} r={9} label="Tags" />
          </g>
        </svg>

        {/* Faux note line */}
        <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950/80 p-3 font-mono text-[11px] leading-relaxed text-neutral-400">
          <span className="text-neutral-200"># Ideas</span>
          <br />
          See <span className="rounded bg-sky-950/50 px-1 text-sky-300">[[Sync]]</span> and{' '}
          <span className="rounded bg-sky-950/50 px-1 text-sky-300">[[Graph]]</span>{' '}
          <span className="rounded bg-sky-950/40 px-1 text-sky-300">#project</span>
        </div>
      </div>
    </div>
  );
}

function GraphNode({
  cx,
  cy,
  r,
  label,
  hub,
}: {
  cx: number;
  cy: number;
  r: number;
  label: string;
  hub?: boolean;
}) {
  return (
    <g className="motion-safe:animate-[fadeIn_500ms_ease-out]">
      <circle cx={cx} cy={cy} r={r} fill="url(#node)" opacity={hub ? 1 : 0.85} />
      <text
        x={cx}
        y={cy + r + 12}
        textAnchor="middle"
        className="fill-neutral-400 text-[10px]"
        fontSize="10"
      >
        {label}
      </text>
    </g>
  );
}

function GraphMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="5" cy="6" r="2.2" fill="currentColor" />
      <circle cx="19" cy="8" r="2.2" fill="currentColor" />
      <circle cx="12" cy="18" r="2.2" fill="currentColor" />
      <path
        d="M6.6 7.4 10.6 16M17.6 9.4 13.4 16M7 6.6 17 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.6"
      />
    </svg>
  );
}
