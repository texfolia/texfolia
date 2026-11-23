# Billing

Stripe billing for the product app: subscription plans, checkout, the customer
portal and webhooks (through the Better Auth Stripe plugin), plan entitlements,
and AI usage metering. See [Configure subscription billing](../../../../../docs/billing.md)
and [AI metering](../../../../../docs/ai-assistant.md#check-metering).

| Entry point                 | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/features/billing`        | Client-safe. Plans: `paidPlans` (public names and monthly USD prices) and `subscriptionPlans` (maps price IDs to Better Auth plans). Usage: `nanoDollars`, `markedUpNanos`. `BillingError` (a refusal with an HTTP status)                                                                                                                                                                                                                                                  |
| `#/features/billing/server` | Checkout, portal and webhooks: `createBillingPlugin`, `authorizeOrganizationBilling`, `enforceBillingScope`. Entitlements: `compilePlan`, `aiEntitlement`. Settings page: `billingOverview`. AI metering: `getAiSettings` (per-user spend cap), `aiSpend`, `reserveAiRequest`, `ensureAiSubscription` (attaches the metered price), `reconcileAiUsage` (prices requests and reports Stripe meter events), and the `MeteringConfig`, `RequestCost` and `MeterReporter` types |

Other features import only these entry points; the remaining files are private. Load
`#/features/billing/server` only on the server: it imports the Stripe SDK.

## Boundaries

The feature depends on `@texfolia/db` (subscriptions, members, AI usage tables)
and `@texfolia/auth`. It does not depend on storage, compile or projects.

- **Checkout, portal and webhooks** are the Better Auth Stripe plugin's
  endpoints (`/api/auth/subscription/*`, `/api/auth/stripe/webhook`). The
  plugin, its plan scope check and organization authorization live in
  `@texfolia/auth`, because `createAuth` installs them; this feature re-exports
  them rather than moving them, so the auth package's API is unchanged. Plan
  data (`paidPlans`) stays in `@texfolia/auth/billing` for the same reason.
- **AI usage metering** lives here, not in the assistant. The assistant asks
  for an entitlement, reserves each request against the user's cap, and
  reconciles after the run. The cost source is injected: `reconcileAiUsage`
  takes a `RequestCost` callback, which the app binds to the AI Gateway logs
  API (`gatewayRequestCost` in `#/features/ai/gateway`). Tests
  pass `report` to capture meter events instead of calling Stripe.

The `/settings/billing` route and its server function, the legacy `/billing`
redirect, the auth route that serves the webhook, and the billing UI stay
outside the feature. `apps/web` `/pricing` reads only `paidPlans` from
`@texfolia/auth/billing`.

## Checks

```sh
bun test apps/app/src/features/billing
```

The database and Stripe paths are covered by the app's integration scripts:
`bun run --cwd apps/app test:ai-billing` (needs `INTEGRATION_DATABASE_URL`) and
`test:billing` (also needs a Stripe sandbox key and prices).
