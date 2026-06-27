/**
 * Pure helpers for rendering the AI server-proxy (BFF) budget / spend meter.
 *
 * The server returns `spendCapState` (and the configured `spendCapUsd`) on
 * GET /v1/ai/config - see `docs/ai-bff.md` §2.2 / §4 and `aiConfigInfoSchema`
 * in `@graphvault/shared`. The Settings UI renders a budget bar from it, and
 * the assistant disables "send" when the window is exhausted.
 *
 * These functions are pure (no React, no DOM) so they can be unit-tested and
 * reused by both the Settings panel and the assistant panel.
 */

import type { AiSpendCapState } from '@graphvault/shared';

/** Visual model for the budget meter, derived from the live spend window. */
export interface BudgetMeter {
  /** 0-100, clamped. The fill width of the bar. */
  percent: number;
  /** Server-reported severity: drives the bar colour. */
  state: AiSpendCapState['state'];
  /** Human-readable spend summary, e.g. "$0.42 / $5.00". */
  spendLabel: string;
  /** Human-readable request summary, e.g. "12 requests today". */
  requestLabel: string;
  /** True when further calls will be refused (429) until the window resets. */
  exhausted: boolean;
}

/** Format a USD amount with cents (never scientific notation). */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '$0.00';
  // Use up to 4 decimals for tiny per-call costs, but at least 2.
  const decimals = amount > 0 && amount < 0.01 ? 4 : 2;
  return `$${amount.toFixed(decimals)}`;
}

/**
 * Build the budget meter view-model from the live spend window and the
 * configured dollar cap.
 *
 * When no dollar cap is configured (`spendCapUsd` is undefined or 0) there is no
 * monetary limit, so the bar is shown at 0% with an "untracked" framing; the
 * `exhausted` flag still honours the server's `state === 'exceeded'` (which can
 * be tripped by the request cap).
 *
 * @param state        Live `spendCapState` from GET /v1/ai/config.
 * @param spendCapUsd  The configured per-day dollar cap (0/undefined = no cap).
 */
export function buildBudgetMeter(
  state: AiSpendCapState,
  spendCapUsd: number | undefined,
): BudgetMeter {
  const cap = spendCapUsd && spendCapUsd > 0 ? spendCapUsd : 0;
  const percent = cap > 0 ? clampPercent((state.windowSpentUsd / cap) * 100) : 0;
  const spendLabel =
    cap > 0
      ? `${formatUsd(state.windowSpentUsd)} / ${formatUsd(cap)}`
      : `${formatUsd(state.windowSpentUsd)} spent (no $ cap)`;
  const requestLabel = `${state.windowRequests} ${state.windowRequests === 1 ? 'request' : 'requests'} today`;
  return {
    percent,
    state: state.state,
    spendLabel,
    requestLabel,
    exhausted: state.state === 'exceeded',
  };
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
}
