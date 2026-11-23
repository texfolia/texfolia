# Configure subscription billing

Texfolia has two paid monthly plans in USD: personal Pro at $15/month and Team at
$20 per organization member per month. Team has no base fee. Each member gets
Pro compile and AI access, including in their personal projects. A personal Pro
subscription and an organization Team subscription remain separate subscriptions.

The billing code lives in [`@texfolia/billing`](../packages/billing/README.md).

## Set up Stripe

1. Set `STRIPE_SECRET_KEY` in `apps/app/.env` to your Stripe sandbox key.
2. Run `bun run --cwd apps/app billing:setup`. The script reuses prices by lookup
   key and validates their currency, amount, interval, and billing scheme. It
   prints `STRIPE_PRO_PRICE_ID` and `STRIPE_TEAM_PRICE_ID` for your environment.
3. Copy those two values into `apps/app/.env`. Team uses the same price for
   `priceId` and `seatPriceId`, so checkout charges only for members.
4. Enable Stripe's customer portal for invoices, payment methods, and subscription
   cancellation. Disable customer changes to plans and quantities in the portal;
   Team seat quantities are managed by organization membership.
5. Forward webhooks as described in the [local setup](../README.md#forward-stripe-webhooks).
   Include `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, and `customer.subscription.deleted` for the
   deployed webhook endpoint.
6. Configure [AI metered billing](ai-assistant.md) separately. The AI usage price is
   attached to an eligible subscription when its first AI run starts.

For production, run the price setup with the production Stripe key and configure
all price IDs, the key, and the webhook signing secret on the deployed Worker.
Sandbox prices and signing secrets cannot be used in production.

## Use shared billing

Open **Billing** from Projects or select **Upgrade to Team** on `/pricing`.
Choose an existing organization or create one, then continue to Stripe checkout.
Only owners and admins can change billing or manage members from this page.

Every organization member is a seat, including owners and admins. Checkout counts
members on the server. Pending invitations do not count. Accepting an invitation,
adding a member, removing a member, or leaving the organization updates the Stripe
quantity through Better Auth's seat hooks, with prorations. Monitor authentication
logs for Stripe seat-sync failures; membership changes should be checked against
Stripe if an API request fails.

The organization pays for eligible members' AI usage on its subscription, with a
separate spend cap for each user. The launch markup is 20%, and the default cap is
$20 per user per UTC month. Each run retains its original payer. See the
[AI billing details](ai-assistant.md) for reservations and reconciliation.

The pricing page advertises the enforced 10 MiB per source file and 50 MiB per
project on every plan. It adds no project-count or editor-count caps. Document
history uses GitHub or GitLab repositories on every plan. AI commit messages use the Pro assistant and are metered. Compile admission and fair-use behavior are unchanged.

## Verify billing

Use an isolated database whose name contains `test`. Apply the current schema with
`DATABASE_URL=<test connection> bun run --cwd packages/db db:push`, then run:

```sh
INTEGRATION_DATABASE_URL=<test connection> bun run --cwd apps/app test:billing
INTEGRATION_DATABASE_URL=<test connection> bun run --cwd apps/app test:pricing
```

`test:billing` requires configured sandbox prices and rejects live Stripe keys. It
creates real sandbox checkout sessions, customers, and paid test subscriptions;
processes signed webhook fixtures using the real subscription responses; and
checks seat changes, payer separation, cancellation, and compile/AI entitlements
against Postgres. It expires checkout sessions, cancels subscriptions, and deletes
its test customers and database fixtures afterward.

`test:pricing` runs the built Worker in Miniflare and drives Chromium at desktop,
tablet, and narrow phone widths. It checks pricing content, CTA destinations,
sign-in returns, checkout request bodies, errors, team creation, seat totals, and
member authorization. It substitutes the checkout HTTP response so the browser
stays in the app. Screenshots are written to `.audit/nat-283/`.

Before release, complete a payment through hosted Stripe Checkout and confirm
webhook delivery to the deployed endpoint. The scripted billing check exercises
webhook processing with signed fixtures, rather than Stripe's network delivery
or the hosted payment form. Verify the customer portal configuration in the same
Stripe account before enabling checkout.

The legacy `/billing` route redirects to `/settings/billing`, preserving plan and organization search parameters.
