// Checkout, the customer portal and Stripe webhooks are Better Auth Stripe
// plugin endpoints. The plugin and its policy live in @texfolia/auth because
// createAuth installs them; they are re-exported here as billing's API.
export {
  authorizeOrganizationBilling,
  createBillingPlugin,
  enforceBillingScope,
} from "@texfolia/auth";
export { aiEntitlement, compilePlan, type AiPayer } from "./entitlements";
export {
  aiSpend,
  ensureAiSubscription,
  getAiSettings,
  reconcileAiUsage,
  reserveAiRequest,
  type MeterReporter,
  type MeteringConfig,
  type RequestCost,
  type UsageCost,
} from "./metering";
export { billingOverview, type BillingOverview } from "./overview";
