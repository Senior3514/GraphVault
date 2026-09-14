# Native mobile (Android + iOS) - setup guide for the owner

## Status

**Not yet built, and could not be scaffolded or built in this sandboxed
session** - both platforms hit a hard environment wall, verified directly
(not assumed):

- **Android**: `tauri android init` requires the official Android SDK to
  already exist locally (it errored `Android SDK not found at
/root/Android/Sdk` and refused to proceed). Installing it requires
  downloading from `dl.google.com`, which this session's sandboxed network
  policy explicitly denies (`403` on the CONNECT, confirmed via the proxy's
  own status log - not a transient failure, a policy decision). No Ubuntu
  `apt` package provides the official SDK layout Tauri's tooling expects
  (`cmdline-tools`, `platforms;android-XX`, `build-tools`, the NDK) - only
  scattered AOSP utility libraries that don't substitute for it.
- **iOS**: requires Xcode, which only runs on macOS. The Tauri CLI installed
  in this Linux sandbox doesn't even expose an `ios` subcommand
  (`tauri ios init` → `error: unrecognized subcommand 'ios'`) - this isn't a
  missing download, it's an Apple platform restriction with no workaround on
  Linux at all.

Both are one-time environment setup steps, not code the app is missing -
GraphVault's desktop build was in an identical state before this session
(four real bugs, nobody had gotten a working native build) until it was
fixed and verified for real. Mobile is architecturally ready to add the same
way; it just needs to happen on a machine with the right platform tools.

## Why this reuses everything already built (not a rewrite)

Tauri 2 supports Android and iOS as additional build targets **for the exact
same project** already in `apps/desktop/src-tauri` - the same Rust core
(`main.rs`, the same two IPC commands), the same web frontend
(`apps/web/out`), the same `tauri.conf.json`. There is no separate mobile
codebase to write or maintain; `tauri android init` / `tauri ios init` add a
native Android Studio / Xcode project _alongside_ the existing desktop
config, and `apps/web`'s `TauriStorageAdapter` (native filesystem
storage, wired up earlier this session) works unchanged on mobile too, once
the OS-level file-picker permissions are granted.

This is why a from-scratch native Kotlin (or Swift) app was the wrong call
(see the earlier discussion in this session) - it would have thrown away the
"one codebase across web + mobile + desktop" advantage this project is built
around for a result Tauri Mobile gets from the same source tree.

## Android - what to run on a properly-provisioned machine

Prerequisites (once, on the machine that will build):

1. **Java 17+** (`java -version`).
2. **Android Studio** (simplest path - it can install everything below for
   you), or the standalone `cmdline-tools` + `sdkmanager` if you'd rather not
   install the full IDE.
3. Via `sdkmanager`, install: a recent `platforms;android-XX`, a matching
   `build-tools;XX.X.X`, and the **NDK** (Tauri needs the NDK specifically,
   not just the SDK, since the Rust core compiles to a native `.so`).
4. Set `ANDROID_HOME` (and `NDK_HOME` if the Tauri CLI doesn't auto-detect it
   from the SDK's `ndk/` subdirectory) in your shell profile.
5. Rust targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`

Then, from the repo root:

```sh
pnpm install
cd apps/desktop
npx tauri android init      # scaffolds an Android Studio project; auto-generates
                             # all required mipmap icon sizes from icons/icon.png
npx tauri android dev       # run on an emulator/device, hot-reloading the web export
npx tauri android build     # release APK + AAB, under src-tauri/gen/android/...
```

Check the exact current requirements against
<https://tauri.app/start/prerequisites/#android> before you start - Tauri's
own docs are the source of truth for SDK/API-level version numbers, which
move faster than this file will stay updated.

## iOS - what to run on a Mac

Prerequisites: **Xcode** (from the Mac App Store) and a **paid Apple
Developer account** (required to run on a real device or submit to the App
Store; the simulator works without one).

```sh
pnpm install
cd apps/desktop
npx tauri ios init          # scaffolds an Xcode project; auto-generates
                             # all required icon sizes from icons/icon.png
npx tauri ios dev           # run in the iOS Simulator
npx tauri ios build         # release .ipa, ready for TestFlight/App Store Connect
```

Check <https://tauri.app/start/prerequisites/#ios> for current requirements.

## One thing worth deciding before either init command runs

`tauri.conf.json`'s `identifier` (`ai.graphvault.desktop`) becomes the
Android `applicationId` **and** the iOS bundle identifier verbatim once
mobile targets are added - the same identifier is shared across every
platform in one Tauri project. Shipping a mobile app with "desktop" baked
into its package name is a little odd, but this project has never
published a build under any identifier yet (no App Store/Play Store
listing exists), so renaming it now (e.g. to `ai.graphvault.app`) is free -
it gets much more disruptive to change later, once a real listing exists
under the old name. Not changed in this pass since it touches the desktop
config too and neither desktop nor mobile could be rebuilt here to confirm
the rename doesn't break anything - flagging it so it's a deliberate choice,
not an accident, whenever mobile setup actually starts.

## What GraphVault will need to add once a target actually builds

Not blocked on anything - just not done yet, since there was nothing to
verify it against in this session:

- Mobile-appropriate window chrome (no desktop-style traffic-light
  decorations; respect safe-area insets - the web app's mobile-responsive
  CSS from Milestone 17 already does this for the PWA, so this is likely
  already correct, just unverified on an actual native mobile WebView).
- A permissions review for the mobile-specific dialog/fs plugin behavior
  (Android's Storage Access Framework and iOS's document-picker sandboxing
  both behave differently from desktop's native file dialog).
- Store listing assets (screenshots, feature graphic, privacy-policy URL)
  once a build is ready to submit.
