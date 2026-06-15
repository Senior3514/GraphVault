import { GRAPHVAULT_API_VERSION, SYNC_PROTOCOL_VERSION } from '@graphvault/shared';

/**
 * Milestone 0 hello-world page. Confirms the web app builds, Tailwind is
 * wired, and the shared package resolves across the workspace.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <div>
        <h1 className="text-4xl font-bold tracking-tight">GraphVault</h1>
        <p className="mt-2 text-lg text-neutral-400">
          Local-first notes. Self-hosted sync. A graph you can think in.
        </p>
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 text-sm">
        <p className="text-neutral-300">Workspace wiring OK ✓</p>
        <ul className="mt-2 space-y-1 text-neutral-400">
          <li>API version: {GRAPHVAULT_API_VERSION}</li>
          <li>Sync protocol version: {SYNC_PROTOCOL_VERSION}</li>
        </ul>
      </div>

      <p className="text-sm text-neutral-500">
        v0 scaffold — see <code className="text-neutral-300">docs/sync-protocol.md</code> for the
        sync design.
      </p>
    </main>
  );
}
