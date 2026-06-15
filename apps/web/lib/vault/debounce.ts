/**
 * Tiny, dependency-free debounce helper.
 *
 * Pure function — no React, no side effects at module scope. Safe to import
 * in both client components and Node.js tests.
 *
 * For a React hook wrapper see {@link useDebounce} in
 * `apps/web/components/SearchBox.tsx` (kept there to avoid React imports in
 * this test-friendly module).
 */

/**
 * Wrap `fn` so it only executes after `delay` ms of inactivity.
 * Each call resets the timer. The returned function also exposes `.cancel()`
 * to abort a pending invocation.
 *
 * @example
 * const debouncedSave = debounce((text: string) => save(text), 400);
 * editor.on('change', debouncedSave);
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number,
): ((...args: Args) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = (...args: Args) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delay);
  };

  debounced.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return debounced;
}
