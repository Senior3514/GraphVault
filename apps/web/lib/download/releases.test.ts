import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DESKTOP_OSES,
  hasAnyInstaller,
  pickAllDesktopAssets,
  pickAssets,
  type ReleaseAsset,
} from './releases';

/**
 * A realistic asset list modelled on the actual `desktop-release.yml` pipeline
 * output for repo `Senior3514/GraphVault`: VERSION-specific filenames, plus the
 * checksum/signature companions GitHub releases often carry (which must be
 * ignored).
 */
function url(name: string): string {
  return `https://github.com/Senior3514/GraphVault/releases/download/v0.2.0/${name}`;
}

const REALISTIC_ASSETS: ReleaseAsset[] = [
  {
    name: 'GraphVault_0.2.0_x64-setup.exe',
    browser_download_url: url('GraphVault_0.2.0_x64-setup.exe'),
  },
  {
    name: 'GraphVault_0.2.0_x64_en-US.msi',
    browser_download_url: url('GraphVault_0.2.0_x64_en-US.msi'),
  },
  {
    name: 'GraphVault_0.2.0_universal.dmg',
    browser_download_url: url('GraphVault_0.2.0_universal.dmg'),
  },
  {
    name: 'GraphVault_0.2.0_amd64.AppImage',
    browser_download_url: url('GraphVault_0.2.0_amd64.AppImage'),
  },
  { name: 'GraphVault_0.2.0_amd64.deb', browser_download_url: url('GraphVault_0.2.0_amd64.deb') },
  // Noise that must be ignored.
  {
    name: 'GraphVault_0.2.0_x64-setup.exe.sig',
    browser_download_url: url('GraphVault_0.2.0_x64-setup.exe.sig'),
  },
  { name: 'latest.json', browser_download_url: url('latest.json') },
  {
    name: 'GraphVault_0.2.0_amd64.AppImage.tar.gz',
    browser_download_url: url('GraphVault_0.2.0_amd64.AppImage.tar.gz'),
  },
  { name: 'checksums.sha256', browser_download_url: url('checksums.sha256') },
];

test('pickAssets picks the .exe as the Windows primary, .msi as alternate', () => {
  const win = pickAssets(REALISTIC_ASSETS, 'windows');
  assert.ok(win.primary, 'expected a Windows primary');
  assert.equal(win.primary?.format, '.exe');
  assert.equal(win.primary?.filename, 'GraphVault_0.2.0_x64-setup.exe');
  assert.equal(win.alternates.length, 1);
  assert.equal(win.alternates[0]?.format, '.msi');
});

test('pickAssets picks the .dmg as the macOS primary, no alternates', () => {
  const mac = pickAssets(REALISTIC_ASSETS, 'macos');
  assert.equal(mac.primary?.format, '.dmg');
  assert.equal(mac.primary?.filename, 'GraphVault_0.2.0_universal.dmg');
  assert.equal(mac.alternates.length, 0);
});

test('pickAssets picks the AppImage as the Linux primary, .deb as alternate', () => {
  const linux = pickAssets(REALISTIC_ASSETS, 'linux');
  assert.equal(linux.primary?.format, '.AppImage');
  assert.equal(linux.primary?.filename, 'GraphVault_0.2.0_amd64.AppImage');
  assert.equal(linux.alternates.length, 1);
  assert.equal(linux.alternates[0]?.format, '.deb');
});

test('pickAssets returns the correct download URLs', () => {
  const win = pickAssets(REALISTIC_ASSETS, 'windows');
  assert.equal(win.primary?.url, url('GraphVault_0.2.0_x64-setup.exe'));
});

test('pickAssets ignores .sig / .tar.gz / checksum / json companion files', () => {
  // Linux primary must be the AppImage, NOT the AppImage.tar.gz companion.
  const linux = pickAssets(REALISTIC_ASSETS, 'linux');
  assert.equal(linux.primary?.filename, 'GraphVault_0.2.0_amd64.AppImage');
  // The .exe.sig must not appear anywhere in Windows results.
  const win = pickAssets(REALISTIC_ASSETS, 'windows');
  const allWin = [win.primary, ...win.alternates].filter(Boolean);
  assert.ok(allWin.every((a) => !a!.filename.endsWith('.sig')));
});

test('pickAssets is tolerant of different version / arch tokens', () => {
  const future: ReleaseAsset[] = [
    { name: 'GraphVault_1.5.3_arm64-setup.exe', browser_download_url: url('a') },
    { name: 'GraphVault_1.5.3_aarch64.dmg', browser_download_url: url('b') },
    { name: 'GraphVault_1.5.3_arm64.AppImage', browser_download_url: url('c') },
  ];
  assert.equal(pickAssets(future, 'windows').primary?.format, '.exe');
  assert.equal(pickAssets(future, 'macos').primary?.format, '.dmg');
  assert.equal(pickAssets(future, 'linux').primary?.format, '.AppImage');
});

test('pickAssets is case-insensitive on the extension', () => {
  const upper: ReleaseAsset[] = [
    { name: 'GraphVault_0.2.0_x64-setup.EXE', browser_download_url: url('a') },
    { name: 'GraphVault_0.2.0_universal.DMG', browser_download_url: url('b') },
  ];
  assert.equal(pickAssets(upper, 'windows').primary?.format, '.exe');
  assert.equal(pickAssets(upper, 'macos').primary?.format, '.dmg');
});

test('pickAssets: only an .msi present → .msi becomes the primary', () => {
  const onlyMsi: ReleaseAsset[] = [
    { name: 'GraphVault_0.2.0_x64_en-US.msi', browser_download_url: url('a') },
  ];
  const win = pickAssets(onlyMsi, 'windows');
  assert.equal(win.primary?.format, '.msi');
  assert.equal(win.alternates.length, 0);
});

test('pickAssets: only a .deb present → .deb becomes the Linux primary', () => {
  const onlyDeb: ReleaseAsset[] = [
    { name: 'GraphVault_0.2.0_amd64.deb', browser_download_url: url('a') },
  ];
  const linux = pickAssets(onlyDeb, 'linux');
  assert.equal(linux.primary?.format, '.deb');
  assert.equal(linux.alternates.length, 0);
});

test('pickAssets returns empty for mobile and unknown OSes', () => {
  for (const os of ['ios', 'android', 'unknown'] as const) {
    const result = pickAssets(REALISTIC_ASSETS, os);
    assert.equal(result.primary, null);
    assert.equal(result.alternates.length, 0);
  }
});

test('pickAssets tolerates null / undefined / non-array assets', () => {
  assert.deepEqual(pickAssets(null, 'windows'), { primary: null, alternates: [] });
  assert.deepEqual(pickAssets(undefined, 'macos'), { primary: null, alternates: [] });
  // @ts-expect-error — intentionally passing a wrong type to prove robustness.
  assert.deepEqual(pickAssets({}, 'linux'), { primary: null, alternates: [] });
});

test('pickAssets skips malformed asset entries without throwing', () => {
  const messy = [
    null,
    undefined,
    { name: 'GraphVault_0.2.0_x64-setup.exe' }, // missing url
    { browser_download_url: url('x') }, // missing name
    { name: 123, browser_download_url: url('y') }, // wrong type
    { name: 'GraphVault_0.2.0_universal.dmg', browser_download_url: url('ok') },
  ] as unknown as ReleaseAsset[];
  const mac = pickAssets(messy, 'macos');
  assert.equal(mac.primary?.filename, 'GraphVault_0.2.0_universal.dmg');
  const win = pickAssets(messy, 'windows');
  assert.equal(win.primary, null, 'the malformed .exe entry (no url) is skipped');
});

test('pickAssets returns no installers for a release with no matching assets', () => {
  const docsOnly: ReleaseAsset[] = [
    { name: 'README.md', browser_download_url: url('a') },
    { name: 'source.tar.gz', browser_download_url: url('b') },
  ];
  for (const os of DESKTOP_OSES) {
    assert.equal(pickAssets(docsOnly, os).primary, null);
  }
  assert.equal(hasAnyInstaller(docsOnly), false);
});

test('pickAllDesktopAssets resolves every desktop OS in one call', () => {
  const all = pickAllDesktopAssets(REALISTIC_ASSETS);
  assert.equal(all.windows.primary?.format, '.exe');
  assert.equal(all.macos.primary?.format, '.dmg');
  assert.equal(all.linux.primary?.format, '.AppImage');
});

test('hasAnyInstaller is true when at least one OS has a primary', () => {
  assert.equal(hasAnyInstaller(REALISTIC_ASSETS), true);
  assert.equal(hasAnyInstaller([]), false);
  assert.equal(hasAnyInstaller(null), false);
});
