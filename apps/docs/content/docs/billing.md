---
title: Configure subscription billing
---

Texfolia has two paid monthly plans in USD (excluding applicable tax): personal Pro at $15/month and Team at
$20 per organization member per month. Team has no base fee. Each member gets
Pro compile access everywhere, and AI access in the organization's projects. A
personal Pro subscription and an organization Team subscription remain separate
subscriptions.

The billing code lives in [`#/lib/billing`](../../../web/src/lib/billing/README.md).

## Set up Stripe

1. Set `STRIPE_SECRET_KEY` in `apps/web/.env` to your Stripe sandbox key.
2. Run `bun run --cwd apps/web billing:setup`. The script creates Pro
   (`txcd_10103000`, SaaS – personal use) and Team (`txcd_10103001`, SaaS –
   business use) products with `tax_behavior: "exclusive"`, or reuses prices by
   lookup key and validates their currency, amount, interval, and billing
   scheme. When `STRIPE_AUTOMATIC_TAX=true`, it also verifies that Pro, Team,
   and (if set) `STRIPE_AI_PRICE_ID` use `tax_behavior: "exclusive"` and the
   expected SaaS `tax_code`. It prints `STRIPE_PRO_PRICE_ID` and
   `STRIPE_TEAM_PRICE_ID` for your environment.
3. Copy those two values into `apps/web/.env`. Team uses the same price for
   `priceId` and `seatPriceId`, so checkout charges only for members.
4. Enable Stripe's customer portal for invoices, payment methods, billing
   address updates, tax IDs, and subscription cancellation. Disable customer
   changes to plans and quantities in the portal; Team seat quantities are
   managed by organization membership.
5. Forward webhooks as described in the [local setup](/local-development/#forward-stripe-webhooks).
   Include `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, and `customer.subscription.deleted` for the
   deployed webhook endpoint.
6. Configure [AI metered billing](/ai-assistant/) separately. The AI usage price is
   attached to an eligible subscription when its first AI run starts.

For production, run the price setup with the production Stripe key and configure
all price IDs, the key, and the webhook signing secret on the deployed Worker.
Sandbox prices and signing secrets cannot be used in production.

## Configure Stripe Tax

Automatic sales tax, VAT, and GST/HST calculation is opt-in via
`STRIPE_AUTOMATIC_TAX=true` (defaults to `false`). Keeping the flag off avoids
checkout failures in self-hosted environments and sandboxes where Stripe Tax has
not been enabled in the Stripe Dashboard.

Before setting `STRIPE_AUTOMATIC_TAX=true` in a test or live environment:

1. Enable **Stripe Tax** in the Stripe Dashboard and set your business origin
   address.
2. Add tax registrations for every jurisdiction where you collect tax (Stripe
   Tax calculates zero tax where you are not registered).
3. Ensure the Customer Portal allows customers to update their billing address
   and tax IDs while keeping plan and quantity changes disabled.
4. Re-run `STRIPE_AUTOMATIC_TAX=true bun run --cwd apps/web billing:setup`
   (with `STRIPE_AI_PRICE_ID` set if AI billing is configured) to confirm that
   Pro, Team, and AI prices use `tax_behavior: "exclusive"` and explicit SaaS
   `tax_code` values (`txcd_10103000` for Pro, `txcd_10103001` for Team, and
   either SaaS code for the shared AI metered price). Existing prices with
   `unspecified` tax behavior can usually be updated once; `inclusive` prices
   must be replaced with new exclusive prices and rotated IDs.

When `STRIPE_AUTOMATIC_TAX=true`, Checkout Sessions send
`automatic_tax: { enabled: true }`, `billing_address_collection: "required"`,
`tax_id_collection: { enabled: true }`, and
`customer_update: { name: "auto", address: "auto" }` (required by Stripe for
existing customers, including Team organizations, when collecting tax IDs).
Renewals, Team seat quantity updates, and later-attached metered AI invoices
inherit `automatic_tax` from the parent subscription.

Enabling the flag applies to new subscriptions created through Checkout. Any
active subscriptions created before Stripe Tax was enabled must be backfilled
in Stripe (setting `automatic_tax[enabled]=true` once each customer has a valid
tax location) or migrated separately.

## Use shared billing

Open **Settings → Billing** or select **Upgrade to Team** on `/pricing`.
Choose an existing organization or create one, then continue to Stripe checkout.
Only owners and admins can change billing. Members are managed in
**Settings → Organizations**; see [Organizations](/project-controls/#organizations).

Every organization member is a seat, including owners and admins. Checkout counts
members on the server. Pending invitations do not count. Accepting an invitation,
adding a member, removing a member, or leaving the organization updates the Stripe
quantity through Better Auth's seat hooks, with prorations. Monitor authentication
logs for Stripe seat-sync failures; membership changes should be checked against
Stripe if an API request fails.

The organization pays for its members' AI usage in its own projects.
Without an eligible Team subscription, the member's personal Pro subscription
pays there instead. Everywhere else, including personal projects and
other organizations' projects, a member needs a personal Pro subscription and
pays for that usage. A collaborator who is not a member never bills the
organization.

Two monthly caps (UTC, pre-tax) bound each request. Every user has a cap across all of
their usage, $20 by default, which they control. Every organization has a shared
cap on all usage billed to it, $100 by default, which only its owners and admins
change under **AI usage** on the billing page (or on **Settings → Usage**). Applicable tax is added on the
Stripe invoice and is not counted against these caps. The launch markup is 20%. Each run
retains its original payer. See the
[AI billing details](/ai-assistant/) for reservations and reconciliation.

## Usage and cost charts

**Settings → Usage** (`/settings/usage`) provides time-series charts, breakdowns,
invoice history, and CSV export for both personal accounts and Team organizations:

- **Personal view**: available to every signed-in user. Shows daily and cumulative AI
  spend (charged vs reserved, pre-tax) plotted against the personal monthly cap,
  breakdowns by model and project, compile job counts (succeeded vs failed) and
  compile minutes, current source storage by project, and personal Stripe invoices
  (with subtotal, tax, and total).
- **Team organization view**: available only to organization **owners and admins**
  via the account switcher on **Settings → Usage** (or linked from **Settings →
  Billing**). Shows shared AI spend versus the organization cap, breakdowns by
  member, model, and project, compile counts and minutes across organization
  projects, source storage, paid seat history, Stripe meter reconciliation, and
  organization invoices with tax. Regular members cannot read organization billing
  or other members' usage.
- **Pre-tax vs invoiced totals**: all AI usage charts, cap progress bars, and
  breakdowns report **pre-tax** usage (model cost plus 20% markup). Official
  Stripe invoices — and the current-period estimated invoice once enabled — show
  subtotal, applicable tax (when `STRIPE_AUTOMATIC_TAX=true`), and total.
- **CSV export**: **Export CSV** (`/api/usage/export`) downloads the visible series
  for the selected scope and period (daily usage, model/project/member breakdowns,
  compiles, storage, seat history, and invoices) using the same authorization rules.

The pricing page advertises the enforced 10 MiB per source file and 50 MiB per
project on every plan. It adds no project-count or editor-count caps. Document
history uses GitHub or GitLab repositories on every plan. AI commit messages use the Pro assistant and are metered. Compile admission and fair-use behavior are unchanged.

## Verify billing

Use an isolated database whose name contains `test`. Apply the current schema with
`DATABASE_URL=<test connection> bun run --cwd packages/db db:push`, then run:

```sh
INTEGRATION_DATABASE_URL=<test connection> bun run --cwd apps/web test:billing
INTEGRATION_DATABASE_URL=<test connection> bun run --cwd apps/web test:pricing
```

`test:billing` requires configured sandbox prices and rejects live Stripe keys. It
creates real sandbox checkout sessions, customers, and paid test subscriptions;
processes signed webhook fixtures using the real subscription responses; and
checks seat changes, payer separation, cancellation, and compile/AI entitlements
against Postgres. By default it verifies the `STRIPE_AUTOMATIC_TAX` off path
(`automatic_tax.enabled === false`); set `STRIPE_AUTOMATIC_TAX=true` against a
sandbox with Stripe Tax enabled in the Dashboard to also verify live Pro and
Team Checkout Sessions with `automatic_tax`, required billing address, and tax
ID collection enabled. It expires checkout sessions, cancels subscriptions, and
deletes its test customers and database fixtures afterward.

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
