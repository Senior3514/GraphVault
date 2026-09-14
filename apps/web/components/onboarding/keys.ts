/**
 * Shared localStorage keys for the onboarding surfaces.
 *
 * Split out from `Tour.tsx` / `OnboardingHint.tsx` so each can reference the
 * other's dismissed-state key without a circular import - the guided Tour
 * and the lightweight Quick Start hint intentionally coordinate (see
 * `OnboardingHint`'s effect and `Tour`'s `dismiss()`) so they never show at
 * the same time and never repeat the same three tips back to back.
 */

export const ONBOARDING_HINT_DISMISSED_KEY = 'graphvault.onboarding.dismissed';
export const TOUR_DISMISSED_KEY = 'graphvault.tour.dismissed';
