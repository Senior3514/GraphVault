/**
 * Register listeners that flush pending edits before the tab is closed or
 * backgrounded (fix #3 — data-loss window on hard close / mobile background).
 *
 * The autosave in `app/vault/page.tsx` debounces writes; on a hard close or a
 * mobile app-switch the pending timer is dropped and the last keystrokes never
 * reach the vault store. We listen for:
 *   - `beforeunload`            — desktop tab close / navigation away.
 *   - `visibilitychange`→hidden — the reliable signal on mobile, where
 *                                 `beforeunload` is often not fired.
 *
 * Returns a cleanup function that removes both listeners. SSR-safe: a no-op when
 * `window`/`document` are unavailable.
 */
export function registerFlushOnExit(flush: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }
  const onBeforeUnload = () => flush();
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
