# Pricing model

GraphVault is **open-core**. The app, the graph, and self-hosting are free and
MIT-licensed forever - that isn't a trial, it's the product.

## Free (available today)

- The full app: editor, graph, command palette, workspace.
- Self-host the sync server yourself, on any VPS, for free.
- Every storage backend (local disk, WebDAV, S3, Azure, GCS).
- Bring-your-own-key AI, or a local model. Off by default.
- No account, no usage limits imposed by us, no telemetry.

## GraphVault Cloud (planned, not yet sold)

An optional convenience tier for people who don't want to run a server:

- **Managed sync relay** - sync across your devices without standing up a VPS.
- **Pooled AI credits** - use the built-in assistant without your own API key.
- **Managed backups** - off-site, retained version history.
- **Priority support.**

Self-hosting stays free and capable on its own - Cloud buys convenience, not
capability you'd otherwise be missing. No launch date yet; see
[`docs/ROADMAP.md`](ROADMAP.md).

## How this fits the privacy promise

Paying for Cloud never changes what happens on the free tier. It also never
weakens the privacy model: Cloud is an _additional_, explicit opt-in - your
notes stay in plain Markdown, exportable at any time, on any plan.

## Technical note (for contributors)

The plan/tier data model lives in
[`packages/shared/src/billing.ts`](../packages/shared/src/billing.ts). It
reuses the existing AI spend-cap metering (`packages/shared/src/ai.ts`) rather
than a parallel system. No payment processor is integrated yet.
