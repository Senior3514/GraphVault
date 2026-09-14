/**
 * Plan/tier model for GraphVault's open-core monetization.
 *
 * NOT wired to a live payment processor. This is the shared, honest data
 * model for the plan a self-hosted server operator (or a future GraphVault
 * Cloud) assigns a user, so feature-gating and metering have a single source
 * of truth. The core app and self-hosting are, and remain, free and MIT.
 *
 * Metering reuses the existing AI spend-cap primitives (see ai.ts) rather
 * than inventing a parallel system - a paid tier is simply a higher/absent
 * cap plus access to gated features below.
 */
import { z } from 'zod';

/**
 * `free`   - the default for every self-hosted server and for the public demo.
 *            Full app, full self-host, no payment ever required.
 * `cloud`  - an optional, paid, hosted convenience tier (managed sync relay,
 *            pooled AI credits, managed backups). Not yet sold; this is the
 *            data shape a future billing integration will populate.
 */
export const planTierSchema = z.enum(['free', 'cloud']);
export type PlanTier = z.infer<typeof planTierSchema>;

export const cloudSubscriptionStatusSchema = z.enum([
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
]);
export type CloudSubscriptionStatus = z.infer<typeof cloudSubscriptionStatusSchema>;

/** Non-secret plan status - safe to return to the client as-is. */
export const planInfoSchema = z.object({
  tier: planTierSchema,
  status: cloudSubscriptionStatusSchema,
  /** ISO 8601. Present only when `status` is `trialing`, `active`, or `past_due`. */
  renewsAt: z.string().datetime().optional(),
});
export type PlanInfo = z.infer<typeof planInfoSchema>;

/**
 * Features gated behind the `cloud` tier. Kept as an explicit allow-list
 * (rather than "everything paid") so the free tier's ceiling is always
 * legible from this one file.
 */
export const cloudFeatureSchema = z.enum([
  'managed-sync-relay',
  'pooled-ai-credits',
  'managed-backups',
  'priority-support',
]);
export type CloudFeature = z.infer<typeof cloudFeatureSchema>;

export function planIncludes(tier: PlanTier, feature: CloudFeature): boolean {
  // `feature` is validated by the caller via cloudFeatureSchema; this keeps
  // the check exhaustive and trivially auditable as features are added.
  void feature;
  return tier === 'cloud';
}
