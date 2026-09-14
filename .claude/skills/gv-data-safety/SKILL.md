---
name: gv-data-safety
description: >-
  Adversarially hunt for and fix data-loss and corruption bugs in GraphVault's
  vault, sync, storage, and backup paths. Use before shipping anything that
  touches notes/persistence, when reviewing autosave / flush / encryption /
  storage-migration / restore / import code, when asked to "make sure we never
  lose data / audit data safety", or as a periodic background sweep. The core
  promise is absolute: never silently lose or overwrite user data.
---

# Data-safety hunt & fix

GraphVault's first law: **never silently lose user data.** This skill finds the
ways that law can break and fixes them with a proof.

## Surfaces to scrutinize

- `apps/web/lib/vault/**` - autosave timers, `useVault`, draft store, flush.
- `apps/web/app/vault/page.tsx` - tab switch/close, flush-on-exit wiring.
- `apps/web/lib/vault/flushOnExit.ts` - `beforeunload` / `visibilitychange`.
- `apps/web/lib/vault/backups.ts` + restore - retention, non-destructive restore.
- `apps/web/lib/vault/encryption/**` - enable/disable/migrate.
- `apps/web/lib/vault/storage/**` - adapters + copy-verify-switch migration.
- `apps/web/lib/vault/portability.ts` - import/export collision safety.
- `packages/sync-core/**` - pull guards, conflict copies, stale-base, delete-edit.

## Invariants to verify (each is a place bugs hide)

- **Writes reach storage before unload.** State updates that defer through React
  effects can be dropped on `beforeunload`/mobile-background - exit flushes must
  write to the adapter *synchronously/directly*, not via async re-render.
- **Never overwrite on import/merge** - collisions become conflict copies.
- **Storage migration is copy → verify (path+content+mtime+ctime) → switch**;
  source is never cleared until the destination is verified.
- **Restore is non-destructive** - snapshot the current state before restoring.
- **Retention never prunes to zero** - the newest N snapshots always survive.
- **Encryption enable/disable parses before overwriting** - a wrong passphrase
  never mutates stored data.
- **Sync** never overwrites locally-dirty files; conflict copies are uniquified.

## Method

1. Read the surface; trace the exact path a keystroke/note takes to durable
   storage and where it could be lost.
2. For each *real* bug: write a **failing** test that demonstrates the loss,
   then fix it, then show the test passing. No test, no fix.
3. If a surface is solid, say "no real bugs found here" - don't invent work.
4. Verify with gv-gauntlet; land with gv-ship.
