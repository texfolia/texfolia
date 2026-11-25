# Billing

Stripe billing for the product app: subscription plans, checkout, the customer
portal and webhooks (through the Better Auth Stripe plugin), plan entitlements,
and AI usage metering. See [Configure subscription billing](../../../../docs/src/content/docs/billing.md)
and [AI metering](../../../../docs/src/content/docs/ai-assistant.md#check-metering).

| Entry point            | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/lib/billing`        | Client-safe. Plans: `paidPlans` (public names and monthly USD prices) and `subscriptionPlans` (maps price IDs to Better Auth plans). Usage: `nanoDollars`, `markedUpNanos`. `BillingError` (a refusal with an HTTP status)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `#/lib/billing/server` | Checkout, portal and webhooks: `createBillingPlugin`, `authorizeOrganizationBilling`, `enforceBillingScope`. Entitlements: `compilePlan`, `aiEntitlement`. Settings page: `billingOverview`, `saveOrganizationAiCap`. AI metering: `getAiSettings` (per-user spend cap), `getOrganizationAiSettings` (shared organization cap), `aiSpend`, `payerAiSpend`, `reserveAiRequest`, `ensureAiSubscription` (attaches the metered price, once per subscription), `forgetAiSubscription`, `reconcileAiUsage` (prices requests and reports Stripe meter events), and the `MeteringConfig`, `RequestCost` and `MeterReporter` types |

The rest of the app imports the core only through these entry points. The
modules that bind it to the app, named below, are imported by path. Load
`#/lib/billing/server` only on the server: it imports the Stripe SDK.

## Boundaries

The feature depends on `@texfolia/db` (subscriptions, members, AI usage tables),
`@texfolia/contracts` (public plans), and `#/lib/auth/roles`. It does not
depend on storage, compile or projects.

- **Checkout, portal and webhooks** are the Better Auth Stripe plugin's
  endpoints (`/api/auth/subscription/*`, `/api/auth/stripe/webhook`). The
  plugin, its plan scope check and organization authorization live in
  `stripe.ts`; `createAuth` in `#/lib/auth/auth` installs them. Plan data
  (`paidPlans`) lives in `@texfolia/contracts/plans`, because `apps/web` shows
  the same prices. `plans.ts` maps price IDs to plans.
- **AI usage metering** lives here, not in the assistant. The assistant asks
  for an entitlement, reserves each request against the user's cap and, when an
  organization pays, its shared cap, and reconciles after the run. The cost source is injected: `reconcileAiUsage`
  takes a `RequestCost` callback, which the app binds to the AI Gateway logs
  API (`gatewayRequestCost` in `#/lib/ai/gateway`). Tests
  pass `report` to capture meter events instead of calling Stripe.

`billing.functions.ts` holds the `/settings/billing` server functions. The route, the legacy `/billing`
redirect, the auth route that serves the webhook, and the billing UI stay
outside the feature. `apps/web` `/pricing` reads only `paidPlans` from
`@texfolia/contracts/plans`.

## Checks

```sh
bun test apps/app/src/lib/billing
```

The database and Stripe paths are covered by the app's integration scripts:
`bun run --cwd apps/app test:ai-billing` (needs `INTEGRATION_DATABASE_URL`) and
`test:billing` (also needs a Stripe sandbox key and prices).
