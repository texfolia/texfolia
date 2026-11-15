# Configure the managed assistant

The editor's **Assistant** button opens chat on the left. Pro users and members
of an active Pro or Team organization can use it. AI usage is separate from
compile limits and the plan price. A conversation lasts until the user leaves
the page; it is not a saved chat history.

## Set up Cloudflare and Stripe

1. Apply `packages/db/sql/20261114_ai_assistant.sql` before deploying. For a new
   local database, `bun run db:push` includes the same tables.
2. Create a Cloudflare AI Gateway, enable persistent logs, enable Unified Billing,
   and fund its credits. Create an account token with **Workers AI Read**,
   **AI Gateway Read**, and **AI Gateway Run** permissions. Models are fetched
   from Cloudflare's catalog; only text models advertising tools, an output token
   limit, and token prices are offered. Models with a separate request fee are
   excluded. There is no user BYOK or direct provider fallback.
3. In Stripe, create a meter with event name `texfolia_ai_nanos`, **sum**
   aggregation, customer field `stripe_customer_id` mapped **by ID**, and value
   field `value`. Use raw events without an hourly or daily aggregation window.
4. Create a recurring **monthly USD** metered price linked to that meter. Set
   `unit_amount_decimal` to `0.0000001` cents: each usage unit is one nano-dollar
   ($0.000000001). Keep the base Pro price unchanged. The server validates the
   price and meter and attaches the usage price to the existing payer's
   subscription on the first AI run, using an idempotency key.
5. Set the following server variables in `apps/web/.env` locally, and as Worker
   secrets or variables in each deployed environment:

   ```dotenv
   CLOUDFLARE_ACCOUNT_ID=<account ID>
   CLOUDFLARE_AI_GATEWAY_ID=<gateway ID>
   CLOUDFLARE_AI_API_TOKEN=<managed server token>
   STRIPE_AI_PRICE_ID=<monthly metered price ID>
   STRIPE_AI_METER_EVENT_NAME=texfolia_ai_nanos
   ```

   `STRIPE_SECRET_KEY` uses the existing integration. Keep test Stripe keys and
   test prices together. The gateway is remote even when the app runs locally.

6. Run the normal local app and compiler. Sign in as a user with an active Pro
   subscription, open a project, and open **Assistant**. Choose a model and send
   a message. Open the usage row to change the monthly cap or save a default
   model. Changing the chat picker alone does not change the saved default.

A Team member uses their project's organization subscription when eligible,
otherwise their personal Pro subscription, otherwise an eligible membership's
subscription. The original customer and subscription are saved with each run,
so later membership or subscription changes do not move existing charges.

## Check metering

Each model request first creates an `ai_request` row. Its reservation includes
20% markup and conservatively bounds input tokens by UTF-8 request bytes plus
framing overhead, with 2,048 output tokens. Concurrent requests lock the user's
settings row and count both actual spend and outstanding reservations. The
cap defaults to $20 per user per UTC calendar month; setting it to $0 pauses AI.
A request can be refused before the displayed cap is exhausted because its
maximum estimated cost does not fit the remaining budget. Provider prices and
token accounting determine the eventual cost; reservations are not charges.

All inference uses `createCloudflareText` with a named gateway. SDK and Gateway
retries are disabled so an unobserved retry cannot create extra billed calls.
The server stores `cf-aig-log-id` before consuming the inference body. Request
metadata includes internal run and request IDs to support reconciliation if a
response is lost. Gateway request/response payload storage is disabled.

After a run succeeds, fails, or stops, reconciliation fetches each log detail.
The base amount is the log's `cost` in USD, rounded up to nano-dollars. The run's
stored 20% markup is applied, rounded up to another whole nano-dollar. Token
usage is stored from both TanStack's usage events and Gateway logs. One Stripe
meter event is sent for each priced request after the run ends, with a stable
identifier and idempotency key. Stripe sums those units on the monthly invoice.
A genuine zero cost is recorded without sending a meter event.

The existing minute cron retries pending pricing and reporting, using database
leases to prevent concurrent reconciliation. The open assistant also retries
its user's pending usage every ten seconds through an authenticated, same-origin
POST; local development does not require cron to settle delayed logs. Exponential
backoff still applies. Runs left running by a dead Worker are marked aborted
after ten minutes. Their persisted requests still settle.

After twelve failed attempts, a request becomes `needs_review`. Missing cost or
a lost log ID never becomes an invented or zero charge. Unpriced requests keep
their reservation; priced requests retain their actual cost if Stripe delivery
fails. Inspect `ai_request.error` and structured `ai_metering_retry` logs. Use the
request ID in Gateway metadata to find a lost log. After correcting the problem,
set its `log_id` if needed and reset only the retry fields:

```sql
UPDATE ai_request
SET status = CASE WHEN charged_nanos IS NULL
                  THEN 'pending'::ai_request_status
                  ELSE 'priced'::ai_request_status END,
    attempts = 0, next_attempt_at = now(), error = NULL
WHERE id = '<reviewed request UUID>';
```

Do not change the original payer, timestamp, amount, or event identifier during
a delivery retry. Uncertain Stripe deliveries older than 23 hours go directly
to review, because Stripe's deduplication window is limited. Confirm whether
Stripe accepted the original event before any manual replay; resetting retry
fields alone intentionally does not bypass that guard. Resolve metering incidents before the invoice finalizes;
Stripe accepts event timestamps only within its recording window. Configure an
invoice finalization grace period appropriate for Gateway log delays. Gateway
costs are estimates, as described in Cloudflare's cost documentation.

## Verify locally

Use an isolated Postgres database whose name contains `test`:

```sh
DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run db:push
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run --cwd apps/web test:ai-billing
bun run --cwd apps/web build
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run --cwd apps/web test:ai-assistant
```

The billing check uses real Postgres transactions and substitutes only external
Gateway and Stripe calls. The assistant check runs the built Worker, TanStack
streaming and tools, local R2, collaboration, and a headless browser. It covers
Pro authorization, Free denial, default models, real file edits, compile
submission, duplicate runs, provider errors, stopping a stream, cap preferences,
and desktop/mobile layouts. It uses synthetic provider and Stripe responses;
it does not make paid inference calls or create real subscriptions. Screenshots
are written to `.audit/nat-266/`.

## Protocol references

- [TanStack's Cloudflare adapter](https://tanstack.com/ai/latest/docs/adapters/cloudflare)
- [Cloudflare REST inference and gateway routing](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [Cloudflare's marketplace-format model catalog](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/)
- [Gateway log detail and optional cost](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/get/)
- [Gateway cost estimates](https://developers.cloudflare.com/ai-gateway/observability/costs/)
- [Stripe meter events and recording windows](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api)
