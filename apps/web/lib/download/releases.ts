/**
 * Pure, UI-independent helpers for resolving native installer downloads from a
 * GitHub Release.
 *
 * The download page fetches the public "latest release" metadata from the
 * GitHub API at runtime (the ONLY network call on that page; it sends no user
 * data and there is no telemetry) and then uses {@link pickAssets} to map the
 * release's assets to the right installer per operating system.
 *
 * Why a pure matcher: release asset filenames are VERSION-specific (e.g.
 * `GraphVault_0.2.0_x64-setup.exe`), so they can never be hardcoded. The
 * matcher is tolerant — it keys off the file extension plus platform tokens —
 * so it keeps working as the version bumps, the architecture changes, or the
 * release pipeline tweaks the naming scheme. Keeping it pure makes it fully
 * unit-testable in Node with realistic asset lists and zero network.
 */

import type { Os } from '../pwa/install';

/**
 * The subset of the GitHub release-asset shape we depend on. The live API
 * returns far more fields; we deliberately read only these two so the matcher
 * stays decoupled from the wire format.
 */
export interface ReleaseAsset {
  /** The asset filename, e.g. `GraphVault_0.2.0_x64-setup.exe`. */
  name: string;
  /** The direct download URL (`browser_download_url` from the GitHub API). */
  browser_download_url: string;
}

/** The subset of the GitHub "latest release" response we depend on. */
export interface GithubRelease {
  /** The git tag, e.g. `v0.2.0`. */
  tag_name?: string;
  /** Human-readable release name (often the same as the tag). */
  name?: string;
  /** The release's assets (uploaded installers). */
  assets?: ReleaseAsset[];
  /** The release's HTML page on GitHub. */
  html_url?: string;
}

/** A resolved installer the UI can render as a download link. */
export interface InstallerLink {
  /** Display label for the format, e.g. `Windows installer (.exe)`. */
  label: string;
  /** Short format token, e.g. `.exe`, `.msi`, `.dmg`, `.AppImage`, `.deb`. */
  format: string;
  /** The original asset filename. */
  filename: string;
  /** Direct download URL. */
  url: string;
}

/**
 * The installers resolved for a single OS:
 *  - `primary`   — the recommended one-click installer (`.exe` / `.dmg` /
 *                  `.AppImage`), or `null` if the release has none for this OS.
 *  - `alternates`— other available formats for the same OS (`.msi`, `.deb`, …),
 *                  offered as "other formats".
 */
export interface OsInstallers {
  primary: InstallerLink | null;
  alternates: InstallerLink[];
}

/**
 * Per-format metadata: which OS it belongs to, a friendly label, and its
 * priority within that OS (lower = preferred as the primary download).
 *
 * Matching is by lowercased filename suffix so it tolerates any version /
 * architecture token in the middle of the name. `.tar.gz` is intentionally NOT
 * matched: GraphVault's pipeline ships AppImage/deb for Linux, and a generic
 * tarball would be ambiguous.
 */
const FORMAT_RULES: ReadonlyArray<{
  os: Exclude<Os, 'ios' | 'android' | 'unknown'>;
  ext: string;
  format: string;
  label: string;
  priority: number;
}> = [
  // Windows — prefer the NSIS .exe setup, offer the .msi as an alternate.
  { os: 'windows', ext: '.exe', format: '.exe', label: 'Windows installer (.exe)', priority: 0 },
  { os: 'windows', ext: '.msi', format: '.msi', label: 'Windows installer (.msi)', priority: 1 },
  // macOS — the universal .dmg is the only/primary format.
  { os: 'macos', ext: '.dmg', format: '.dmg', label: 'macOS disk image (.dmg)', priority: 0 },
  // Linux — prefer the portable AppImage, offer the .deb as an alternate.
  { os: 'linux', ext: '.appimage', format: '.AppImage', label: 'Linux AppImage', priority: 0 },
  { os: 'linux', ext: '.deb', format: '.deb', label: 'Debian/Ubuntu package (.deb)', priority: 1 },
];

/**
 * Match a single asset filename to a format rule, or `null` if it is not a
 * recognised installer (e.g. checksum files, source tarballs, signatures).
 *
 * Tolerant by design: it only inspects the lowercased suffix, so it survives
 * arbitrary version/architecture tokens (`_0.2.0_x64`, `_universal`,
 * `_amd64`, …) anywhere before the extension. `.sig`/`.sha256` companions are
 * rejected because their suffix is not one of the installer extensions.
 */
function matchAsset(name: string): (typeof FORMAT_RULES)[number] | null {
  const lower = name.toLowerCase();
  for (const rule of FORMAT_RULES) {
    if (lower.endsWith(rule.ext)) return rule;
  }
  return null;
}

/**
 * Resolve the installer(s) for a given OS from a release's asset list. Pure:
 * same inputs → same output, no DOM/network.
 *
 * - Mobile (`ios`/`android`) and `unknown` always return no installers — there
 *   is no native mobile binary; those users get the web/PWA path.
 * - For desktop OSes, assets are matched by extension + platform token, sorted
 *   by the rule priority (then filename for determinism), and the
 *   highest-priority match becomes `primary`; the rest are `alternates`.
 * - Defensive against `null`/`undefined`/malformed assets so a flaky API
 *   response can never throw in the render path.
 */
export function pickAssets(
  assets: readonly ReleaseAsset[] | null | undefined,
  os: Os,
): OsInstallers {
  const empty: OsInstallers = { primary: null, alternates: [] };
  if (os === 'ios' || os === 'android' || os === 'unknown') return empty;
  if (!Array.isArray(assets)) return empty;

  const matched: Array<{ link: InstallerLink; priority: number }> = [];
  for (const asset of assets) {
    if (
      !asset ||
      typeof asset.name !== 'string' ||
      typeof asset.browser_download_url !== 'string'
    ) {
      continue;
    }
    const rule = matchAsset(asset.name);
    if (!rule || rule.os !== os) continue;
    matched.push({
      priority: rule.priority,
      link: {
        label: rule.label,
        format: rule.format,
        filename: asset.name,
        url: asset.browser_download_url,
      },
    });
  }

  if (matched.length === 0) return empty;

  // Stable sort: by priority, then by filename so ties are deterministic.
  matched.sort((a, b) => a.priority - b.priority || a.link.filename.localeCompare(b.link.filename));

  const [primary, ...alternates] = matched.map((m) => m.link);
  return { primary: primary ?? null, alternates };
}

/** The OSes that have native desktop installers, in display order. */
export const DESKTOP_OSES: ReadonlyArray<Exclude<Os, 'ios' | 'android' | 'unknown'>> = [
  'windows',
  'macos',
  'linux',
];

/**
 * Build a per-OS installer map for all desktop OSes in one pass over the
 * assets. Convenience wrapper around {@link pickAssets} for the UI, which shows
 * the detected OS prominently and the others as secondary options.
 */
export function pickAllDesktopAssets(
  assets: readonly ReleaseAsset[] | null | undefined,
): Record<Exclude<Os, 'ios' | 'android' | 'unknown'>, OsInstallers> {
  return {
    windows: pickAssets(assets, 'windows'),
    macos: pickAssets(assets, 'macos'),
    linux: pickAssets(assets, 'linux'),
  };
}

/** True when at least one desktop OS has a resolvable installer in the release. */
export function hasAnyInstaller(assets: readonly ReleaseAsset[] | null | undefined): boolean {
  return DESKTOP_OSES.some((os) => pickAssets(assets, os).primary !== null);
}
