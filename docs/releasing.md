# Releasing GraphVault

This document describes how to cut a versioned release that ships signed (or
unsigned-draft) native installers for macOS, Linux, and Windows.

---

## Prerequisites

- CI must be fully green on the commit you intend to tag. The release pipeline
  does NOT run the test suite - that is CI's job. A tag on a red commit is a
  release of broken software.
- You need write access (push tags) to the repository.
- Optional: platform code-signing credentials stored as GitHub Actions secrets
  (see [Signing secrets](#signing-secrets) below). Without them the action still
  builds and uploads unsigned installers, which is fine for a draft reviewed
  before publication.

---

## Cutting a release

1. **Confirm CI is green** on the branch/commit you are releasing.

2. **Pick a version number** following [Semantic Versioning](https://semver.org).
   GraphVault is pre-1.0, so `0.x.y` is normal. Patch releases increment `y`;
   new features (even minor ones in pre-1.0) increment `x`.

3. **Tag the commit** and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

   Pushing a `v*` tag triggers `.github/workflows/desktop-release.yml`
   automatically. No extra manual steps are needed.

4. **Watch the Actions run.** Three parallel jobs start - one per platform
   (`macos-latest`, `ubuntu-latest`, `windows-latest`). Each job:

   - Installs JS dependencies (`pnpm install --frozen-lockfile`).
   - Runs `pnpm run build:web` to produce the static Next.js export that Tauri
     bundles.
   - Compiles the Rust shell and bundles the platform installer via `tauri build`.
   - Uploads the installer(s) to a **draft** GitHub Release named
     `GraphVault vX.Y.Z`.

   The matrix uses `fail-fast: false`, so if one platform fails the other two
   still complete and upload their artefacts.

5. **Review the draft release** on GitHub (Releases → draft). Attach release
   notes, confirm the artefacts look correct, then click "Publish release".

---

## Manual / pre-release build

You can also trigger the workflow without a tag using the manual dispatch:

1. Go to Actions → "Desktop Release" → "Run workflow".
2. Choose the branch and whether to mark the release as draft (default: true).

This is useful for testing the pipeline or producing a pre-release build
without permanently tagging the repository.

---

## Installer artefacts

| Platform | Artefact(s)           | Notes                                           |
| -------- | --------------------- | ----------------------------------------------- |
| macOS    | `.dmg` (universal)    | Universal binary: arm64 + x86_64 in one file    |
| Linux    | `.AppImage`, `.deb`   | AppImage runs on most distros without install   |
| Windows  | `.msi`, `.exe` (NSIS) | MSI for managed deployments; NSIS for end-users |

Artefacts land in the draft release automatically. The raw files are also
available in the Actions run summary under "Artifacts" if you need them before
the release is published.

---

## Signing secrets

All signing secrets are optional. Without them the action builds and uploads
unsigned installers. Configure them in GitHub → Settings → Secrets → Actions.

### macOS (notarised .dmg)

| Secret                       | Description                                     |
| ---------------------------- | ----------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded `.p12` Developer ID certificate  |
| `APPLE_CERTIFICATE_PASSWORD` | Passphrase for the `.p12`                       |
| `APPLE_SIGNING_IDENTITY`     | e.g. `Developer ID Application: Name (TEAM_ID)` |
| `APPLE_ID`                   | Apple ID email used for notarisation            |
| `APPLE_PASSWORD`             | App-specific password for notarisation          |
| `APPLE_TEAM_ID`              | 10-character Apple team ID                      |

Obtain a **Developer ID Application** certificate from
[developer.apple.com](https://developer.apple.com/account/resources/certificates/list).
Notarisation requires an [app-specific password](https://support.apple.com/HT204397),
not your main Apple ID password.

### Windows (signed .msi / .exe)

| Secret                         | Description                                    |
| ------------------------------ | ---------------------------------------------- |
| `WINDOWS_CERTIFICATE`          | Base64-encoded `.pfx` code-signing certificate |
| `WINDOWS_CERTIFICATE_PASSWORD` | Passphrase for the `.pfx`                      |

### Tauri auto-updater (future)

If `tauri-plugin-updater` is enabled (not yet; see
`apps/desktop/src-tauri/tauri.conf.json`), also add:

| Secret                               | Description                                   |
| ------------------------------------ | --------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Ed25519 private key (`tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passphrase for the key                        |

---

## CI vs release - responsibilities

| Workflow        | File                                    | Purpose                                                             |
| --------------- | --------------------------------------- | ------------------------------------------------------------------- |
| CI              | `.github/workflows/ci.yml`              | Every push/PR: typecheck + lint + format + test + `build:web`       |
| Desktop Release | `.github/workflows/desktop-release.yml` | Every `v*` tag: cross-platform `tauri build` + GitHub Release draft |

The CI workflow must be green before you tag. The release workflow does not
re-run the test suite - it trusts CI.

---

## Troubleshooting

**macOS job fails with "no Rust targets":** the `dtolnay/rust-toolchain` action
installs `aarch64-apple-darwin,x86_64-apple-darwin` for the universal build. If
the targets list is empty for other platforms this is intentional.

**Linux job fails with missing webkit2gtk:** the workflow installs
`libwebkit2gtk-4.1-dev` and other Tauri prerequisites automatically. If new
system deps are needed, add them to the `apt-get install` step in
`.github/workflows/desktop-release.yml`.

**Windows job fails mid-compile:** free GitHub-hosted Windows runners are slower
than macOS/Linux. The job timeout is 60 minutes which is generous; most Rust
cold-compile runs finish within 35-45 minutes.

**Installer not in the draft release:** each platform uploads independently. If
one platform job failed, its installer will be missing from the draft. Fix the
failing job, delete the draft release, and push a new tag (or use
`workflow_dispatch` to re-run without a new tag, then manually attach artefacts).
