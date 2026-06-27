'use client';

/**
 * Shared focus-trap hook for modal overlays (mobile drawers, dialogs).
 *
 * Extracted from `AppFrame` so every `role="dialog" aria-modal="true"` overlay
 * can reuse the same, tested behaviour instead of re-implementing it (or, worse,
 * declaring `aria-modal` with no trap at all - which strands keyboard / screen
 * reader users behind the curtain).
 *
 * Behaviour while `active`:
 *  - Focuses the first focusable element in `containerRef` on activation.
 *  - Keeps Tab / Shift+Tab cycling within the container (wraps at both ends).
 *  - Restores focus to `restoreRef` (if given) when the trap deactivates.
 *
 * Escape-to-close is intentionally NOT handled here: different overlays close
 * differently (some toggle page state, some pop a router). Callers wire their
 * own Escape handler; see `useEscapeToClose` for a small shared helper.
 */

import { useEffect } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps keyboard focus inside `containerRef` while `active` is true.
 * Returns focus to `restoreRef` when deactivated.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  restoreRef?: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!active || !containerRef.current) return;
    const container = containerRef.current;

    // Focus the first focusable element when the trap activates.
    const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable.length > 0) {
      focusable[0].focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const all = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.closest('[hidden]') && el.offsetParent !== null,
      );
      if (all.length === 0) return;
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Restore focus when trap deactivates.
      restoreRef?.current?.focus?.();
    };
  }, [active, containerRef, restoreRef]);
}

/**
 * Calls `onClose` when Escape is pressed while `active` is true. A small
 * companion to {@link useFocusTrap} for overlays that close on Escape.
 */
export function useEscapeToClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, onClose]);
}
