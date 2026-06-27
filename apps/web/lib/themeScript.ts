/**
 * No-flash theme boot script.
 *
 * This runs synchronously in <head> BEFORE first paint, so the correct
 * `data-theme` is on <html> before any styled content is rendered - preventing
 * a light/dark flash on load (FOUC). It is intentionally tiny, dependency-free,
 * and self-contained (no imports) because it is serialised verbatim into an
 * inline <script>.
 *
 * CSP: this is an inline script, allowed under the static-export policy
 * `script-src 'self' 'unsafe-inline'`. It uses NO eval()/new Function(), so it
 * does NOT require 'unsafe-eval'.
 *
 * The literal key/default below MUST stay in lockstep with `lib/theme.ts`
 * (THEME_STORAGE_KEY = 'gv-theme', DEFAULT_THEME_MODE = 'system').
 */
export const THEME_BOOT_SCRIPT = `(function(){try{
var m=localStorage.getItem('gv-theme');
if(m!=='light'&&m!=='dark'&&m!=='system')m='system';
var dark=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.dataset.theme=dark?'dark':'light';
}catch(e){document.documentElement.dataset.theme='dark';}})();`;
