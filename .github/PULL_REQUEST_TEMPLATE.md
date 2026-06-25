<!-- Thanks for contributing to GraphVault! -->

## What & why

<!-- What does this change do, and why? Link any related issue (e.g. Closes #123). -->

## How it was tested

<!-- Commands run, scenarios exercised, new tests added. -->

## Checklist

- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run lint` passes
- [ ] `pnpm run format:check` passes
- [ ] `pnpm -r test` passes (added/updated tests for new logic)
- [ ] `pnpm run build:web` passes
- [ ] **Data safety:** no path can silently lose or overwrite user notes
- [ ] **Privacy:** no new telemetry; note content/credentials don't leave the device unless the user opts in
- [ ] External input is validated (shared zod schemas where applicable)
