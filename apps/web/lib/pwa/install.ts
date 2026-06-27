/**
 * Pure, UI-independent helpers for the "Get the app" / install experience.
 *
 * These functions take their inputs explicitly (user-agent string, a
 * `matchMedia`-like predicate, navigator flags) so they can be unit-tested in
 * Node with zero DOM. The React component in
 * `components/InstallButton.tsx` wires the live browser values in.
 *
 * Why this exists: PWA install affordances are deeply platform-specific —
 * Chromium fires `beforeinstallprompt`, iOS Safari never does (Add to Home
 * Screen is the only path), and an already-installed app must hide the CTA
 * entirely. Keeping that decision logic pure makes it auditable and testable.
 *
 * Zero telemetry, zero network: this module only reads strings/booleans.
 */

/** Coarse runtime platform classification, derived from the user-agent. */
export type Platform = 'ios' | 'android' | 'desktop' | 'unknown';

/**
 * Which install affordance to present.
 *
 * - `prompt`      — a programmatic `beforeinstallprompt` is available; show an
 *                   "Install app" button that triggers the native dialog.
 * - `ios-hint`    — iOS Safari; show the "Share → Add to Home Screen" hint
 *                   (the only install path Apple offers).
 * - `manual-hint` — another browser without `beforeinstallprompt` (e.g. Firefox,
 *                   desktop Safari); point at the browser menu.
 * - `none`        — already installed / running standalone; show nothing.
 */
export type InstallAffordance = 'prompt' | 'ios-hint' | 'manual-hint' | 'none';

/** Inputs the affordance decision depends on — all explicitly injected. */
export interface InstallEnv {
  /** `navigator.userAgent` (lower-casing is handled internally). */
  userAgent: string;
  /** True when the app is already running as an installed PWA. */
  standalone: boolean;
  /** True once a `beforeinstallprompt` event has been captured. */
  hasPromptEvent: boolean;
}

/**
 * Classify the platform from a user-agent string.
 *
 * iPadOS 13+ reports a desktop-Safari UA, so we additionally treat a
 * "Macintosh" UA that also exposes touch as iOS — but since touch isn't in the
 * UA string, callers that care should pass {@link detectIosFromNavigator}.
 */
export function detectPlatform(userAgent: string): Platform {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  if (/windows|macintosh|mac os x|linux|cros/.test(ua)) return 'desktop';
  return 'unknown';
}

/**
 * True when the user-agent is iOS *Safari* specifically (not an in-app webview
 * or Chrome/Firefox on iOS, which all wrap WebKit but expose their own tokens).
 * Only Safari can Add to Home Screen, so the hint must target it.
 */
export function isIosSafari(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  if (!isIos) return false;
  // CriOS = Chrome iOS, FxiOS = Firefox iOS, EdgiOS = Edge iOS, OPiOS = Opera.
  const isOtherBrowser = /crios|fxios|edgios|opios|mercury/.test(ua);
  return !isOtherBrowser;
}

/**
 * Detect an iPad reporting a desktop UA (iPadOS 13+). Needs the live navigator
 * because the touch signal is not present in the UA string. Kept separate from
 * {@link detectPlatform} so the latter stays a pure string function.
 */
export function detectIosFromNavigator(nav: {
  userAgent: string;
  maxTouchPoints?: number;
  platform?: string;
}): boolean {
  if (detectPlatform(nav.userAgent) === 'ios') return true;
  // iPadOS 13+ masquerades as macOS Safari but has a touch screen.
  const macLike = /mac/i.test(nav.platform ?? '') || /macintosh/i.test(nav.userAgent);
  return macLike && (nav.maxTouchPoints ?? 0) > 1;
}

/**
 * Decide which install affordance to show. Pure: same inputs → same output.
 *
 * Precedence:
 *  1. Already standalone → `none` (never nag an installed user).
 *  2. A captured prompt event → `prompt` (works on Chromium desktop/Android).
 *  3. iOS Safari → `ios-hint` (Add to Home Screen is the only path).
 *  4. Anything else → `manual-hint`.
 */
export function chooseInstallAffordance(env: InstallEnv): InstallAffordance {
  if (env.standalone) return 'none';
  if (env.hasPromptEvent) return 'prompt';
  if (isIosSafari(env.userAgent)) return 'ios-hint';
  return 'manual-hint';
}

/**
 * Whether the app is running as an installed/standalone PWA, given the results
 * of the relevant media queries and the iOS-only `navigator.standalone` flag.
 * Pure so it can be tested without a real `matchMedia`.
 */
export function isStandalone(opts: {
  displayModeStandalone: boolean;
  displayModeFullscreen?: boolean;
  displayModeMinimalUi?: boolean;
  iosStandalone?: boolean;
}): boolean {
  return Boolean(
    opts.displayModeStandalone ||
    opts.displayModeFullscreen ||
    opts.displayModeMinimalUi ||
    opts.iosStandalone,
  );
}
