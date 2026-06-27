import Link from 'next/link';
import { InstallButton } from '../components/InstallButton';

/**
 * Marketing landing page - rendered full-bleed (no app chrome) via AppFrame.
 *
 * Design goals:
 *  - Four core GraphVault promises front-and-center (local-first, self-hosted
 *    sync, graph-for-thinking, security).
 *  - Real-feeling product preview built from CSS + SVG only; zero external
 *    image or script fetches, zero telemetry.
 *  - Tasteful motion gated behind `motion-safe:` so prefers-reduced-motion is
 *    always honoured.
 *  - Social-proof strip + "star us on GitHub" CTA.
 *  - Dark-first with DESIGN.md's sky-400/neutral palette.
 */

export default function LandingPage() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-neutral-950 text-neutral-100">
      {/* ------------------------------------------------------------------ */}
      {/* Ambient backdrop - pure CSS, no images                              */}
      {/* ------------------------------------------------------------------ */}

      {/* Top aurora glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(70rem_50rem_at_50%_-15%,theme(colors.sky.500/18),transparent)]"
      />
      {/* Secondary accent - lower right */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 right-0 h-[50rem] w-[50rem] translate-x-1/3 translate-y-1/3 bg-[radial-gradient(circle,theme(colors.violet.600/8),transparent_70%)]"
      />
      {/* Dot grid */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.045] [background-image:radial-gradient(theme(colors.neutral.400)_1px,transparent_1px)] [background-size:28px_28px]"
      />

      <div className="relative">
        {/* ================================================================ */}
        {/* NAV                                                               */}
        {/* ================================================================ */}
        <header className="sticky top-0 z-40 border-b border-neutral-900/80 bg-neutral-950/80 backdrop-blur-md">
          <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 sm:py-4">
            <Link
              href="/"
              className="flex items-center gap-2.5 text-base font-semibold tracking-tight text-neutral-100 transition-opacity hover:opacity-80"
            >
              <GraphMark className="h-6 w-6 text-sky-400" />
              <span>GraphVault</span>
            </Link>

            <div className="flex items-center gap-3 text-sm sm:gap-5">
              <Link
                href="/graph"
                className="hidden text-neutral-400 transition-colors hover:text-neutral-100 sm:block"
              >
                Graph
              </Link>
              <Link
                href="/vault"
                className="hidden text-neutral-400 transition-colors hover:text-neutral-100 sm:block"
              >
                Vault
              </Link>
              <Link
                href="/download"
                className="hidden text-neutral-400 transition-colors hover:text-neutral-100 sm:block"
              >
                Download
              </Link>
              <a
                href="https://github.com/Senior3514/GraphVault"
                className="hidden items-center gap-1.5 text-neutral-400 transition-colors hover:text-neutral-100 sm:flex"
                target="_blank"
                rel="noreferrer"
              >
                <GitHubIcon className="h-4 w-4" />
                GitHub
              </a>
              {/* Tap target ≥ 44px via min-h-[44px] */}
              <Link
                href="/vault"
                className="inline-flex min-h-[44px] items-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-neutral-950 shadow-md shadow-sky-500/25 transition-all hover:bg-sky-400 hover:shadow-sky-400/30 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
              >
                Open GraphVault
              </Link>
            </div>
          </nav>
        </header>

        {/* ================================================================ */}
        {/* HERO                                                              */}
        {/* ================================================================ */}
        <section className="mx-auto grid max-w-6xl gap-10 px-4 pb-10 pt-14 sm:px-6 sm:pt-24 lg:grid-cols-[1fr_480px] lg:items-center lg:gap-16">
          {/* Left - copy */}
          <div className="motion-safe:animate-slide-up">
            {/* Badge */}
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/70 px-3.5 py-1.5 text-xs text-neutral-400 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse" />
              Local-first · No account needed · No telemetry, ever
            </div>

            <h1 className="text-balance text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl sm:text-6xl xl:text-7xl">
              Notes that live{' '}
              <span className="relative whitespace-nowrap">
                <span className="relative z-10 text-sky-400">on your terms</span>
                {/* Underline accent */}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 300 12"
                  className="absolute -bottom-1 left-0 w-full fill-sky-500/25"
                  preserveAspectRatio="none"
                >
                  <path d="M0 9 Q150 0 300 9" />
                </svg>
              </span>
              .
            </h1>

            <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-neutral-400">
              GraphVault is a local-first Markdown app with self-hosted sync and a graph you can
              actually think in. Open straight into your vault - no folder picker, no &quot;allow
              access to your files&quot; dialog. Start writing in seconds.
            </p>

            {/* Keyboard hints */}
            <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-neutral-500">
              <span>
                Press <Kbd>Cmd</Kbd>
                <Kbd>K</Kbd> to go anywhere
              </span>
              <span aria-hidden="true" className="text-neutral-800">
                ·
              </span>
              <span>
                Type <Kbd>[[</Kbd> to link notes
              </span>
              <span aria-hidden="true" className="text-neutral-800">
                ·
              </span>
              <span>
                <Kbd>#</Kbd> for tags
              </span>
            </p>

            {/* CTAs - the primary action is unmistakable; min-h-[44px] keeps
                every touch target above the accessibility floor. */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/vault"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sky-500 px-5 py-2.5 font-semibold text-neutral-950 shadow-lg shadow-sky-500/25 transition-all hover:bg-sky-400 hover:shadow-sky-400/30 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
              >
                Open GraphVault
                <ArrowRightIcon className="h-4 w-4" />
              </Link>
              {/* Download the native app - routes to the OS-aware download page. */}
              <Link
                href="/download"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-5 py-2.5 font-medium text-sky-300 transition-all hover:border-sky-500/60 hover:bg-sky-500/15 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
              >
                <DownloadIcon className="h-4 w-4" />
                Download the app
              </Link>
              {/* PWA install affordance - platform-aware; renders nothing when
                  already installed or when install isn't possible. */}
              <InstallButton />
              <a
                href="https://github.com/Senior3514/GraphVault"
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 px-5 py-2.5 font-medium text-neutral-200 transition-all hover:border-neutral-700 hover:bg-neutral-900 focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
              >
                <GitHubIcon className="h-4 w-4 text-neutral-400" />
                Star on GitHub
              </a>
            </div>

            {/* One-line trust statement - the whole pitch in a breath. */}
            <p className="mt-4 text-sm text-neutral-500">
              Works offline · No account · Your files stay yours.
            </p>
          </div>

          {/* Right - product preview */}
          <div className="motion-safe:animate-slide-up-delay">
            <ProductPreview />
          </div>
        </section>

        {/* ================================================================ */}
        {/* SOCIAL PROOF TICKER                                               */}
        {/* ================================================================ */}
        <section className="border-y border-neutral-900/80 bg-neutral-950/60 py-3">
          <div className="mx-auto max-w-6xl px-6">
            <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm text-neutral-500">
              <StatBadge icon="⭐" label="Open source on GitHub" />
              <span aria-hidden="true" className="hidden text-neutral-800 sm:block">
                ·
              </span>
              <StatBadge icon="🔒" label="Zero telemetry, by design" />
              <span aria-hidden="true" className="hidden text-neutral-800 sm:block">
                ·
              </span>
              <StatBadge icon="📁" label="Plain Markdown on disk - no lock-in" />
              <span aria-hidden="true" className="hidden text-neutral-800 sm:block">
                ·
              </span>
              <StatBadge icon="🔄" label="Self-hosted sync on any VPS" />
            </div>
          </div>
        </section>

        {/* ================================================================ */}
        {/* FOUR CORE PROMISES                                                */}
        {/* ================================================================ */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <SectionLabel>Core promises</SectionLabel>
          <h2 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            Everything you need. Nothing you don&apos;t.
          </h2>
          <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-neutral-400">
            GraphVault is built around four non-negotiable principles. We don&apos;t add features
            that compromise them.
          </p>

          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <PromiseCard
              icon={<FileIcon />}
              accent="sky"
              title="Local-first, no lock-in"
              description="Your vault is plain Markdown. Unzip the export and you have readable .md files - no proprietary database, no import step."
            />
            <PromiseCard
              icon={<SyncIcon />}
              accent="violet"
              title="Self-hosted sync"
              description="One small open-source server on your own VPS. Per-device tokens, conflict-aware, content-addressed - it never silently loses a note."
            />
            <PromiseCard
              icon={<GraphIcon />}
              accent="emerald"
              title="A graph to think in"
              description="Every note and link becomes a navigable graph with live physics, typed relations, hover highlights, and filters - a first-class tool."
            />
            <PromiseCard
              icon={<ShieldIcon />}
              accent="amber"
              title="Security-conscious"
              description="TLS by default, hashed passwords, optional AES-256-GCM at-rest encryption, zero telemetry. Your notes are yours."
            />
          </div>
        </section>

        {/* ================================================================ */}
        {/* FEATURE SHOWCASE - annotated screenshot mockup                    */}
        {/* ================================================================ */}
        <section className="border-y border-neutral-900 bg-neutral-950/40 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionLabel>The vault</SectionLabel>
            <h2 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
              A full Markdown workspace - in your browser.
            </h2>

            <div className="mt-12 grid gap-8 lg:grid-cols-2 lg:items-center">
              <VaultPreview />

              <div className="space-y-6">
                {[
                  {
                    title: 'Command palette',
                    desc: (
                      <>
                        Press <Kbd>Cmd</Kbd>
                        <Kbd>K</Kbd> to quick-open any note, run commands, or jump between views
                        without touching the mouse.
                      </>
                    ),
                  },
                  {
                    title: 'Wikilink autocomplete',
                    desc: (
                      <>
                        Type <Kbd>[[</Kbd> anywhere in the editor to link notes with autocomplete.
                        Backlinks surface automatically in the details pane.
                      </>
                    ),
                  },
                  {
                    title: 'Split editor',
                    desc: (
                      <>
                        Press <Kbd>Cmd</Kbd>
                        <Kbd>E</Kbd> for a live side-by-side editor+preview. Open two notes at once
                        with the split tab control.
                      </>
                    ),
                  },
                  {
                    title: 'Export anytime',
                    desc: 'Download a lossless Markdown ZIP or a JSON backup with one click - no account, no internet required.',
                  },
                ].map(({ title, desc }) => (
                  <FeatureLine key={title} title={title}>
                    {desc}
                  </FeatureLine>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ================================================================ */}
        {/* GRAPH SECTION                                                     */}
        {/* ================================================================ */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
            <div>
              <SectionLabel>The graph</SectionLabel>
              <h2 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
                Not just a pretty hairball.
              </h2>
              <p className="mt-4 max-w-xl text-pretty text-base leading-relaxed text-neutral-400">
                GraphVault&apos;s graph is a real navigation tool - degree-scaled nodes, live
                physics, hover highlights, and click-to-open. Filter by tag, type, or date. Double
                click to open a note without leaving the graph.
              </p>

              <div className="mt-8 space-y-3">
                {[
                  'Hover to highlight connected notes; dim the rest',
                  'Click a node to open a detail panel with backlinks',
                  'Filter by tag, note type, or depth',
                  'Live physics controls: link distance, repel, gravity',
                  'Zoom to fit, reset, or pin nodes anywhere',
                ].map((feat) => (
                  <div key={feat} className="flex items-start gap-2.5 text-sm text-neutral-400">
                    <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    {feat}
                  </div>
                ))}
              </div>

              <div className="mt-8">
                <Link
                  href="/graph"
                  className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 px-5 py-2.5 text-sm font-medium text-neutral-200 transition-all hover:border-neutral-700 hover:bg-neutral-900"
                >
                  Open the graph
                  <ArrowRightIcon className="h-4 w-4" />
                </Link>
              </div>
            </div>

            <GraphSVGPreview />
          </div>
        </section>

        {/* ================================================================ */}
        {/* COMPARISON                                                        */}
        {/* ================================================================ */}
        <section className="border-t border-neutral-900 bg-neutral-950/50 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl px-4 sm:px-6">
            <SectionLabel centered>Why GraphVault</SectionLabel>
            <h2 className="mt-2 text-center text-balance text-3xl font-bold tracking-tight sm:text-4xl">
              All the power. None of the friction.
            </h2>

            {/* Desktop: 3-column table; Mobile: stacked cards per feature */}
            <div className="mt-12 overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/40">
              {/* Table header - only shown on sm+ */}
              <div className="hidden grid-cols-3 border-b border-neutral-800 text-xs font-semibold uppercase tracking-wide sm:grid">
                <div className="px-5 py-3 text-neutral-500">Feature</div>
                <div className="border-l border-neutral-800 px-5 py-3 text-neutral-500">Others</div>
                <div className="border-l border-neutral-800 bg-sky-500/5 px-5 py-3 text-sky-400">
                  GraphVault
                </div>
              </div>

              {[
                ['Setup required', 'Folder picker / app install', 'Open the URL → done'],
                ['File format', 'Often proprietary', 'Plain Markdown, always'],
                ['Sync', 'Paid cloud or manual', 'Self-host on any VPS, free'],
                ['Graph view', 'Decorative / limited', 'First-class navigation tool'],
                ['Telemetry', 'Usually on by default', 'Off, unconditionally'],
                ['Export', 'Sometimes locked', 'One-click Markdown ZIP'],
              ].map(([feat, them, us]) => (
                <div key={feat} className="border-t border-neutral-800/60">
                  {/* Desktop row */}
                  <div className="hidden grid-cols-3 text-sm sm:grid">
                    <div className="px-5 py-3.5 text-neutral-400">{feat}</div>
                    <div className="border-l border-neutral-800 px-5 py-3.5 text-neutral-600">
                      {them}
                    </div>
                    <div className="border-l border-neutral-800 bg-sky-500/5 px-5 py-3.5 font-medium text-neutral-200">
                      {us}
                    </div>
                  </div>
                  {/* Mobile stacked card */}
                  <div className="px-4 py-3 sm:hidden">
                    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      {feat}
                    </div>
                    <div className="flex flex-col gap-1 text-sm">
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 shrink-0 text-[10px] uppercase tracking-wide text-neutral-600 w-16">
                          Others
                        </span>
                        <span className="text-neutral-600">{them}</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-sky-400 w-16">
                          GV
                        </span>
                        <span className="font-medium text-neutral-200">{us}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ================================================================ */}
        {/* GITHUB STAR CTA                                                   */}
        {/* ================================================================ */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="relative overflow-hidden rounded-2xl border border-neutral-800 bg-gradient-to-br from-neutral-900 via-neutral-900 to-neutral-950 px-6 py-12 text-center shadow-2xl shadow-black/40 sm:px-8 sm:py-14">
            {/* Decorative glow */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(40rem_20rem_at_50%_-10%,theme(colors.sky.500/12),transparent)]"
            />

            <div className="relative">
              {/* Star animation row */}
              <div className="mb-4 flex justify-center">
                <div className="flex items-center gap-1" aria-label="Five star rating">
                  {[...Array<null>(5)].map((_, i) => (
                    <svg
                      key={i}
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="h-5 w-5 text-amber-400 motion-safe:animate-fade-in"
                      style={{ animationDelay: `${i * 80}ms`, animationFillMode: 'both' }}
                      aria-hidden="true"
                    >
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                  ))}
                </div>
              </div>

              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Love GraphVault? Star it on GitHub.
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-base text-neutral-400">
                It&apos;s open-source, self-hostable, and gets better with every star. No account
                needed to try the app - just open it and write.
              </p>

              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <a
                  href="https://github.com/Senior3514/GraphVault"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-neutral-100 px-6 py-3 font-semibold text-neutral-950 shadow-lg transition-all hover:bg-white hover:shadow-xl focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
                >
                  <GitHubIcon className="h-5 w-5" />
                  Star on GitHub
                </a>
                <Link
                  href="/vault"
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 px-6 py-3 font-medium text-neutral-100 transition-all hover:border-neutral-600 hover:bg-neutral-800"
                >
                  Open the app
                  <ArrowRightIcon className="h-4 w-4" />
                </Link>
              </div>

              <p className="mt-4 text-xs text-neutral-600">
                No telemetry · Plain Markdown · Self-hosted sync · Zero vendor lock-in
              </p>
            </div>
          </div>
        </section>

        {/* ================================================================ */}
        {/* FOOTER                                                            */}
        {/* ================================================================ */}
        <footer className="border-t border-neutral-900">
          <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
            <div className="flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-center">
              <div>
                <Link href="/" className="flex items-center gap-2 text-sm font-semibold">
                  <GraphMark className="h-5 w-5 text-sky-400" />
                  GraphVault
                </Link>
                <p className="mt-1.5 text-xs text-neutral-600">
                  Local-first notes. Self-hosted sync. A graph you can think in.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-5 text-sm text-neutral-500">
                <Link href="/vault" className="transition-colors hover:text-neutral-300">
                  Vault
                </Link>
                <Link href="/graph" className="transition-colors hover:text-neutral-300">
                  Graph
                </Link>
                <Link href="/download" className="transition-colors hover:text-neutral-300">
                  Download
                </Link>
                <Link href="/settings" className="transition-colors hover:text-neutral-300">
                  Settings
                </Link>
                <a
                  href="https://github.com/Senior3514/GraphVault"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 transition-colors hover:text-neutral-300"
                >
                  <GitHubIcon className="h-4 w-4" />
                  Open source
                </a>
              </div>
            </div>

            <div className="mt-8 border-t border-neutral-900 pt-6 text-xs text-neutral-700">
              No telemetry, ever. Your notes stay on your device.
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
}

// ============================================================================
// PRODUCT PREVIEW - CSS/SVG mock of the vault + graph UI
// ============================================================================

/**
 * Simulates the app shell with a note editor on the left and a mini graph
 * panel on the right. Entirely CSS + inline SVG - no canvas, no images.
 */
function ProductPreview() {
  return (
    <div className="relative">
      {/* Outer shadow / glow */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -m-4 rounded-3xl bg-[radial-gradient(50%_50%_at_50%_50%,theme(colors.sky.500/15),transparent)] blur-2xl"
      />

      <div className="relative overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60 ring-1 ring-white/[0.06] motion-safe:animate-float">
        {/* Titlebar chrome */}
        <div className="flex items-center gap-1.5 border-b border-neutral-800 bg-neutral-950/80 px-3 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" aria-hidden="true" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" aria-hidden="true" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" aria-hidden="true" />
          <span className="ml-3 text-[11px] text-neutral-600">GraphVault</span>
          <span className="ml-auto text-[11px] text-neutral-600">vault · graph</span>
        </div>

        {/* Two-panel layout */}
        <div className="flex">
          {/* Left: faux editor */}
          <div className="min-w-0 flex-1 border-r border-neutral-800 p-4">
            {/* File tree */}
            <div className="mb-3 space-y-0.5 text-[11px]">
              {[
                { name: 'Ideas.md', active: true },
                { name: 'Sync.md', active: false },
                { name: 'Graph.md', active: false },
                { name: 'Tags.md', active: false },
              ].map(({ name, active }) => (
                <div
                  key={name}
                  className={`rounded px-2 py-1 ${
                    active
                      ? 'bg-neutral-800 text-neutral-100'
                      : 'text-neutral-600 hover:text-neutral-400'
                  }`}
                  aria-current={active ? 'page' : undefined}
                >
                  {name}
                </div>
              ))}
            </div>

            {/* Divider */}
            <div className="my-3 border-t border-neutral-800" />

            {/* Editor content */}
            <div className="space-y-1.5 font-mono text-[11px] leading-relaxed">
              <div className="font-semibold text-neutral-100"># Ideas</div>
              <div className="text-neutral-500">
                See <span className="rounded bg-sky-950/60 px-1 text-sky-300">[[Sync]]</span>
                {' and '}
                <span className="rounded bg-sky-950/60 px-1 text-sky-300">[[Graph]]</span>
              </div>
              <div className="text-neutral-500">
                <span className="rounded bg-sky-950/40 px-1 text-sky-400">#project</span>{' '}
                <span className="rounded bg-sky-950/40 px-1 text-sky-400">#v0</span>
              </div>
              <div className="h-3" />
              <div className="text-neutral-600">## Notes so far</div>
              <div className="text-neutral-600">- Build the graph view</div>
              <div className="text-neutral-600">- Wire up backlinks panel</div>
              {/* Blinking cursor */}
              <div className="flex items-center text-neutral-600">
                <span>- </span>
                <span className="ml-px h-3 w-0.5 bg-sky-400 motion-safe:animate-pulse" />
              </div>
            </div>
          </div>

          {/* Right: faux graph */}
          <div className="w-40 bg-neutral-950/60 p-2">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
              Graph
            </div>
            <svg
              viewBox="0 0 120 130"
              className="w-full"
              role="img"
              aria-label="Animated node graph preview"
            >
              <defs>
                <radialGradient id="hub-grad" cx="50%" cy="30%" r="70%">
                  <stop offset="0%" stopColor="#7dd3fc" />
                  <stop offset="100%" stopColor="#0ea5e9" />
                </radialGradient>
                <radialGradient id="sat-grad" cx="50%" cy="30%" r="70%">
                  <stop offset="0%" stopColor="#a78bfa" />
                  <stop offset="100%" stopColor="#7c3aed" />
                </radialGradient>
                <radialGradient id="grn-grad" cx="50%" cy="30%" r="70%">
                  <stop offset="0%" stopColor="#6ee7b7" />
                  <stop offset="100%" stopColor="#10b981" />
                </radialGradient>
              </defs>
              {/* Edges */}
              <g stroke="#1e3a5f" strokeWidth="1.2" opacity="0.8">
                <line x1="60" y1="60" x2="25" y2="25" />
                <line x1="60" y1="60" x2="95" y2="28" />
                <line x1="60" y1="60" x2="22" y2="92" />
                <line x1="60" y1="60" x2="98" y2="88" />
                <line x1="60" y1="60" x2="60" y2="112" />
                <line x1="25" y1="25" x2="95" y2="28" />
                <line x1="22" y1="92" x2="60" y2="112" />
              </g>
              {/* Hub node */}
              <circle cx="60" cy="60" r="11" fill="url(#hub-grad)" />
              {/* Satellite nodes */}
              <circle cx="25" cy="25" r="7" fill="url(#sat-grad)" opacity="0.9" />
              <circle cx="95" cy="28" r="7" fill="url(#grn-grad)" opacity="0.9" />
              <circle cx="22" cy="92" r="6" fill="url(#sat-grad)" opacity="0.8" />
              <circle cx="98" cy="88" r="6" fill="url(#grn-grad)" opacity="0.8" />
              <circle cx="60" cy="112" r="5.5" fill="url(#hub-grad)" opacity="0.7" />
              {/* Labels */}
              <text x="60" y="76" textAnchor="middle" fontSize="8" fill="#94a3b8">
                Ideas
              </text>
              <text x="25" y="14" textAnchor="middle" fontSize="7" fill="#94a3b8">
                Sync
              </text>
              <text x="95" y="17" textAnchor="middle" fontSize="7" fill="#94a3b8">
                Graph
              </text>
              <text x="18" y="106" textAnchor="middle" fontSize="7" fill="#94a3b8">
                Notes
              </text>
              <text x="102" y="102" textAnchor="middle" fontSize="7" fill="#94a3b8">
                Tags
              </text>
            </svg>
          </div>
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-between border-t border-neutral-800/60 bg-neutral-950/60 px-3 py-1.5 text-[10px] text-neutral-600">
          <span>4 notes · 6 links · 2 tags</span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Saved
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// VAULT PREVIEW (feature section)
// ============================================================================

function VaultPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/80 shadow-2xl shadow-black/40">
      {/* Chrome */}
      <div className="flex items-center gap-1.5 border-b border-neutral-800 bg-neutral-950/70 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-red-500/50" />
        <span className="h-2 w-2 rounded-full bg-amber-500/50" />
        <span className="h-2 w-2 rounded-full bg-emerald-500/50" />
        <span className="mx-auto text-[10px] text-neutral-600">vault / meeting-notes.md</span>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0.5 border-b border-neutral-800 bg-neutral-950/40 px-2 pt-1">
        {['Ideas.md', 'meeting-notes.md', '+'].map((tab, i) => (
          <div
            key={tab}
            className={`rounded-t px-3 py-1.5 text-[11px] ${
              i === 1
                ? 'border border-b-neutral-900 border-neutral-800 bg-neutral-900 text-neutral-200'
                : i === 2
                  ? 'text-neutral-600'
                  : 'text-neutral-600'
            }`}
          >
            {tab}
          </div>
        ))}
      </div>

      {/* Split editor + preview */}
      <div className="flex text-[11px]">
        {/* Editor side */}
        <div className="min-w-0 flex-1 border-r border-neutral-800 p-4 font-mono">
          <div className="text-neutral-100">## Q3 Planning</div>
          <div className="mt-1 text-neutral-500">
            Goals: finish <span className="text-sky-300">[[Graph]]</span> v2
          </div>
          <div className="text-neutral-500">
            and wire up <span className="text-sky-300">[[Sync]]</span>.
          </div>
          <div className="mt-2 text-neutral-500">
            <span className="text-sky-400">#milestone</span>{' '}
            <span className="text-sky-400">#planning</span>
          </div>
          <div className="mt-2 text-neutral-600">- [ ] Ship export flow</div>
          <div className="text-neutral-600">- [x] Auth complete</div>
          <div className="flex items-center text-neutral-600">
            <span>- [ ] </span>
            <span className="ml-px h-2.5 w-0.5 bg-sky-400 motion-safe:animate-pulse" />
          </div>
        </div>

        {/* Preview side */}
        <div className="min-w-0 flex-1 p-4">
          <div className="text-base font-semibold text-neutral-100">Q3 Planning</div>
          <div className="mt-1.5 leading-relaxed text-neutral-400">
            Goals: finish <span className="rounded bg-sky-950/50 px-0.5 text-sky-300">Graph</span>{' '}
            v2 and wire up <span className="rounded bg-sky-950/50 px-0.5 text-sky-300">Sync</span>.
          </div>
          <div className="mt-2 flex gap-1">
            <span className="rounded bg-sky-950/40 px-1 text-xs text-sky-400">#milestone</span>
            <span className="rounded bg-sky-950/40 px-1 text-xs text-sky-400">#planning</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-neutral-400">
            <span className="flex h-3 w-3 items-center justify-center rounded-sm border border-neutral-600">
              <span className="h-1.5 w-1.5 rounded-sm bg-neutral-600" />
            </span>
            Ship export flow
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-neutral-400 line-through opacity-60">
            <span className="flex h-3 w-3 items-center justify-center rounded-sm border border-emerald-600 bg-emerald-600/20">
              <CheckIcon className="h-2.5 w-2.5 text-emerald-400" />
            </span>
            Auth complete
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// GRAPH SVG PREVIEW (graph section)
// ============================================================================

function GraphSVGPreview() {
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="absolute inset-0 -m-6 rounded-3xl bg-[radial-gradient(50%_50%_at_50%_50%,theme(colors.emerald.500/10),transparent)] blur-3xl"
      />

      <div className="relative overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/70 p-5 shadow-2xl shadow-black/50 ring-1 ring-white/[0.05]">
        {/* Chrome */}
        <div className="mb-4 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Global graph
          </span>
          <span className="ml-auto flex items-center gap-1.5 rounded-full border border-neutral-800 px-2 py-0.5 text-[10px] text-neutral-600">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
            note
            <span className="ml-1 h-1.5 w-1.5 rounded-full bg-violet-400" />
            tag
            <span className="ml-1 h-1.5 w-1.5 rounded-full bg-amber-400/70" />
            unresolved
          </span>
        </div>

        <svg
          viewBox="0 0 380 280"
          className="w-full"
          role="img"
          aria-label="Graph view showing interconnected notes"
        >
          <defs>
            <radialGradient id="g-hub" cx="50%" cy="30%" r="70%">
              <stop offset="0%" stopColor="#7dd3fc" />
              <stop offset="100%" stopColor="#0284c7" />
            </radialGradient>
            <radialGradient id="g-sat" cx="50%" cy="30%" r="70%">
              <stop offset="0%" stopColor="#c4b5fd" />
              <stop offset="100%" stopColor="#7c3aed" />
            </radialGradient>
            <radialGradient id="g-grn" cx="50%" cy="30%" r="70%">
              <stop offset="0%" stopColor="#6ee7b7" />
              <stop offset="100%" stopColor="#059669" />
            </radialGradient>
            <radialGradient id="g-amb" cx="50%" cy="30%" r="70%">
              <stop offset="0%" stopColor="#fcd34d" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#d97706" stopOpacity="0.6" />
            </radialGradient>
            {/* Hover glow filter */}
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Background grid lines */}
          <g stroke="#1a2330" strokeWidth="0.5" opacity="0.6">
            {[60, 120, 180, 240, 300, 360].map((x) => (
              <line key={`v${x}`} x1={x} y1="0" x2={x} y2="280" />
            ))}
            {[60, 120, 180, 240].map((y) => (
              <line key={`h${y}`} x1="0" y1={y} x2="380" y2={y} />
            ))}
          </g>

          {/* Edges */}
          <g stroke="#1e3a5f" strokeWidth="1.5" opacity="0.7">
            {/* Hub connections */}
            <line x1="190" y1="140" x2="80" y2="70" />
            <line x1="190" y1="140" x2="300" y2="65" />
            <line x1="190" y1="140" x2="70" y2="195" />
            <line x1="190" y1="140" x2="310" y2="195" />
            <line x1="190" y1="140" x2="145" y2="230" />
            <line x1="190" y1="140" x2="240" y2="230" />
            {/* Secondary connections */}
            <line x1="80" y1="70" x2="145" y2="230" />
            <line x1="300" y1="65" x2="310" y2="195" />
            <line x1="70" y1="195" x2="145" y2="230" />
            <line x1="310" y1="195" x2="240" y2="230" />
            {/* Peripheral */}
            <line x1="80" y1="70" x2="30" y2="130" />
            <line x1="300" y1="65" x2="350" y2="120" />
            <line x1="80" y1="70" x2="130" y2="30" />
            <line x1="300" y1="65" x2="260" y2="25" />
          </g>

          {/* Satellite cluster - peripheral nodes */}
          <circle cx="30" cy="130" r="5" fill="url(#g-grn)" opacity="0.7" />
          <circle cx="350" cy="120" r="5" fill="url(#g-grn)" opacity="0.7" />
          <circle cx="130" cy="30" r="5" fill="url(#g-sat)" opacity="0.7" />
          <circle cx="260" cy="25" r="5" fill="url(#g-sat)" opacity="0.7" />
          {/* Unresolved nodes */}
          <circle cx="55" cy="245" r="4.5" fill="url(#g-amb)" opacity="0.6" />
          <circle cx="330" cy="248" r="4.5" fill="url(#g-amb)" opacity="0.6" />

          {/* Primary ring nodes */}
          <circle cx="80" cy="70" r="9" fill="url(#g-sat)" />
          <circle cx="300" cy="65" r="9" fill="url(#g-grn)" />
          <circle cx="70" cy="195" r="8" fill="url(#g-sat)" />
          <circle cx="310" cy="195" r="8" fill="url(#g-grn)" />
          <circle cx="145" cy="230" r="8" fill="url(#g-sat)" opacity="0.9" />
          <circle cx="240" cy="230" r="8" fill="url(#g-grn)" opacity="0.9" />

          {/* Hub - glowing center */}
          <circle cx="190" cy="140" r="6" fill="url(#g-hub)" filter="url(#glow)" opacity="0.5" />
          <circle cx="190" cy="140" r="14" fill="url(#g-hub)" />

          {/* Labels */}
          <text x="190" y="160" textAnchor="middle" fontSize="9" fill="#94a3b8">
            Ideas
          </text>
          <text x="80" y="56" textAnchor="middle" fontSize="8" fill="#94a3b8">
            Sync
          </text>
          <text x="300" y="51" textAnchor="middle" fontSize="8" fill="#94a3b8">
            Graph
          </text>
          <text x="70" y="213" textAnchor="middle" fontSize="8" fill="#94a3b8">
            Notes
          </text>
          <text x="310" y="213" textAnchor="middle" fontSize="8" fill="#94a3b8">
            Tags
          </text>
          <text x="145" y="248" textAnchor="middle" fontSize="8" fill="#94a3b8">
            Projects
          </text>
          <text x="240" y="248" textAnchor="middle" fontSize="8" fill="#94a3b8">
            Archive
          </text>
        </svg>

        {/* Controls strip */}
        <div className="mt-3 flex items-center justify-between border-t border-neutral-800 pt-3">
          <div className="flex items-center gap-1">
            {['Zoom in', 'Zoom out', 'Fit'].map((label) => (
              <div
                key={label}
                className="rounded border border-neutral-800 px-2 py-0.5 text-[10px] text-neutral-600"
              >
                {label}
              </div>
            ))}
          </div>
          <div className="text-[10px] text-neutral-600">7 nodes · 14 edges</div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SMALL COMPONENTS
// ============================================================================

function SectionLabel({ children, centered }: { children: React.ReactNode; centered?: boolean }) {
  return (
    <p
      className={`text-xs font-semibold uppercase tracking-widest text-sky-400 ${centered ? 'text-center' : ''}`}
    >
      {children}
    </p>
  );
}

function StatBadge({ icon, label }: { icon: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

function PromiseCard({
  icon,
  accent,
  title,
  description,
}: {
  icon: React.ReactNode;
  accent: 'sky' | 'violet' | 'emerald' | 'amber';
  title: string;
  description: string;
}) {
  const accentMap = {
    sky: 'border-sky-400/20 bg-sky-500/10 text-sky-300',
    violet: 'border-violet-400/20 bg-violet-500/10 text-violet-300',
    emerald: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-300',
    amber: 'border-amber-400/20 bg-amber-500/10 text-amber-300',
  };

  return (
    <div className="group rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 transition-all hover:border-neutral-700 hover:bg-neutral-900">
      <span
        aria-hidden="true"
        className={`flex h-10 w-10 items-center justify-center rounded-lg border ${accentMap[accent]}`}
      >
        {icon}
      </span>
      <h3 className="mt-4 text-base font-semibold text-neutral-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-neutral-400">{description}</p>
    </div>
  );
}

function FeatureLine({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-sky-400/20 bg-sky-500/10">
        <CheckIcon className="h-3.5 w-3.5 text-sky-400" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-neutral-400">{children}</p>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 inline-block rounded border border-neutral-700 bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[11px] font-medium leading-none text-neutral-300 shadow-sm">
      {children}
    </kbd>
  );
}

// ============================================================================
// SVG ICONS
// ============================================================================

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

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
      aria-hidden="true"
    >
      <path d="M10 3v9M6 8l4 4 4-4M4 15h12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 10h12M12 6l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 8l3.5 3.5L13 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SyncIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <circle cx="4" cy="5" r="2" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="15" r="2" />
      <path
        d="M5.7 6.2 8.6 13.4M14.4 8.3 11.4 13.4M6 5.3 14.2 6.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
        opacity="0.7"
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
        clipRule="evenodd"
      />
    </svg>
  );
}
