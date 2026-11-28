---
title: Configure the managed assistant
---

The editor’s left **Agents** sidebar contains saved project chats. Open it from
**View → Agents sidebar** or the status bar. Pro users can use it in any
project they can edit or view. Members of a Team organization can use it in that
organization's projects. AI usage is separate from compile limits and
the plan price. Chats are stored on the server, privately for each user and project.
The history button in the bottom-left status bar opens a separate sidebar to
the left of Agents, hidden by default. Its list creates, renames, deletes, and
switches conversations. The active chat keeps its own panel beside history.

The implementation lives in [`#/lib/ai`](../../../../app/src/lib/ai/README.md): chat runs,
tools, saved threads, skills, and the panel UI. The app keeps the `/api/ai` route,
the Gateway secrets, and the workspace panel that hosts the UI.

## Chat history and display

`ai_thread` owns a conversation’s title and optional model override.
`ai_message` stores ordered TanStack UI messages, including tool calls, results and
reasoning. These tables cascade with the user and project; billing records keep
their existing independent lifetime. The server loads the transcript and accepts
only the new user text from the browser. It checkpoints streamed replies every five
seconds, writing only messages that changed, and saves partial replies when stopped.
Only one reply can run in a thread at a time. Saving the reply and settling its usage
run under `waitUntil`, so they finish even when the browser disconnects. The thread
accepts the next message as soon as the reply is saved, before usage is settled.
Retry replaces the last answer while preserving the original user message.

A user can keep 200 chats in a project; creating another is refused until one is
deleted. The history list loads 50 at a time. A chat is full at 1,000 messages or
8 MiB.

The interface follows the current shadcn/ui AI Elements patterns: Message Scroller,
Message, Input Group for Prompt Input, a Model Selector dropdown, Trace for Tool
and Reasoning, Code Block, Sources and Suggestion. Tool inputs and results render
as named fields rather than raw JSON. Copy and retry actions appear on messages;
in-progress states use shadcn’s `shimmer` utility. No reasoning-effort control is
added. A chat’s model override survives reloads. **Save AI preferences** sets the
user’s default model for new chats and the existing monthly spending cap.

## Set up Cloudflare and Stripe

1. Apply the schema locally with `bun run db:push`. For production, follow the
   [baseline migration setup](/database-deployment/#prepare-the-baseline-at-launch).
2. Create a Cloudflare AI Gateway, enable persistent logs, enable Unified Billing,
   and fund its credits. Create an account token with **Workers AI Read**,
   **AI Gateway Read**, and **AI Gateway Run** permissions. Models are fetched
   from Cloudflare's catalog; only text models advertising tools, an output token
   limit, and token prices are offered. Models with a separate request fee are
   excluded. There is no user BYOK or direct provider fallback.
3. In Stripe, create a meter with event name `texfolia_ai_nanos`, **sum**
   aggregation, customer field `stripe_customer_id` mapped **by ID**, and value
   field `value`. Use raw events without an hourly or daily aggregation window.
4. Create a recurring **monthly USD** metered price linked to that meter, with
   `tax_behavior` set to `exclusive` and a SaaS product `tax_code`
   (`txcd_10103001`, or `txcd_10103000`). Set `unit_amount_decimal` to
   `0.0000001` cents: each usage unit is one nano-dollar ($0.000000001). Keep
   the base Pro price unchanged. The server validates the price and meter and
   attaches the usage price to the existing payer's subscription on the first AI
   run, using an idempotency key (`proration_behavior: "none"`; the metered
   item inherits `automatic_tax` from the parent subscription). It records that
   in `ai_meter_attachment` and asks Stripe again after a day, after a webhook
   reports that the subscription changed, or when the price or meter setting
   changes. Webhooks must include `customer.subscription.updated` and
   `customer.subscription.deleted`, which billing already needs.
5. Set the following server variables in `apps/app/.env` locally, and as Worker
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
   subscription, open a project, and open **Agents** and start a chat. Choose a model and send
   a message. Open the usage row to change the monthly cap or save a default
   model. Changing the chat picker alone does not change the saved default.

A member of a project's organization uses its subscription when eligible,
otherwise their personal Pro subscription. An organization never pays in a
personal project or another organization's project. The original customer and subscription are saved with each run,
so later membership or subscription changes do not move existing charges.

File tools can list, search, and read saved sources. Editors' runs can also
apply several exact replacements to a file in one versioned `edit_file` call,
and create, rename, move, or delete files and folders through the same node
functions and path rules as the Files sidebar. `search_project` matches literal
text, returns at most 200 lines, skips files over 1 MiB, and scans at most 16 MiB
per search. It reads six files at a time and keeps only their matches.

### Reviewing and undoing changes

A finished `edit_file` call shows each replacement as a diff, with **Revert this
edit** or **Revert all edits**. Created files can be removed, and renames undone.
**Undo changes from here** on one of your messages undoes every change the assistant
made after it, latest first. It is a rollback of files; the chat keeps its messages.

No file versions are stored for this. An edit is undone from its tool call: the
`newText` is replaced by the `oldText` in the live document, where up to 80
characters of context on each side, kept in the tool's result, say it is.
`compactHistory` removes that context from what the model is sent. A change whose
text has been edited since is left alone and listed with the reason, and the rest
are undone. A created file is removed only while its text is unchanged. Deleted files
and Git actions cannot be undone from a chat. Undoing is an edit of the
collaborative document by the person who asked for it: collaborators see it, and
the editor's Undo takes it back. It needs edit access, waits until the document is
connected, and is disabled while a reply runs. Edits from before this feature have no
context and cannot be reverted.

### Requests from the editor

**Fix with AI** and **Ask AI about selection** write into the message field, and
start a chat when there is none. They never send it. Typing `@` completes a project
file's path; the assistant reads the file with `read_file`.

Git tools can inspect status and diffs, commit, push, pull, create branches, and
switch branches. The assistant instructions require an explicit user request before
git mutations. The **Generate message** button in the Git panel uses the same
subscription, Gateway, spending cap, and usage meter. It suggests an editable
message and creates no commit. See [Git integration](/git-integration/).

## Agent instructions, skills, and snippets

Texfolia uses open file conventions, so the same files work with any agent,
including one that runs on a Git clone of the project:

- `AGENTS.md` ([agents.md](https://agents.md)) at the project root holds
  project instructions. An `AGENTS.md` in a folder applies to that folder.
- Skills live in `.agents/skills/<name>/SKILL.md` and follow the
  [Agent Skills format](https://agentskills.io/specification): YAML
  frontmatter with `name` (matching the folder name) and `description`, then
  Markdown instructions.
- Snippets are ordinary project files. Put them anywhere in the project, or
  in a skill's `assets/` folder when a skill uses them. There is no snippet store.

These are normal project files. They sync through Git and ZIP export
like any other file. Texfolia does not use a proprietary format or database for them.

The assistant loads them on demand. The read-only `list_skills` tool returns
each skill's name, description, path and any format problems, plus the paths
of `AGENTS.md` files. It does not return file bodies. The assistant reads a
skill or `AGENTS.md` with `read_file` only when it matches the request, so
their text uses context only when needed. The instructions tell the assistant
that these files cannot authorize actions the user did not request, such as
deleting files or changing Git state. This matters because collaborators
and imported repositories can add them. Adding `AGENTS.md` or a skill index to the system
prompt is still undecided; see NAT-415 and the context budget in NAT-373.

The read-only `read_scratchpad` tool returns the project's shared notes, up to
64 KiB, to anyone who can use the assistant on the project, including viewers.
No tool writes the scratchpad. Like project files, its text is untrusted: the
instructions say it cannot authorize deletions, Git changes, or anything else the
user did not request. Share-link guests cannot use the assistant, and the
collaboration room refuses their principals.

Project viewers can use the assistant for read-only questions. Their runs
receive only `list_files`, `list_skills`, `search_project`, `read_file`,
`read_scratchpad`, `git_status`,
`git_diff`, and `read_compile_logs`; file edits, file creation, renames,
deletions, compiles, and git mutations are not offered.
The server write checks still apply to editors' tool calls. A run stops if the
user's role changes while it is in progress.

The model catalog is cached for ten minutes, so a new, removed or repriced model can
take that long to show. Cached prices only size reservations.

## Check metering

Metering lives in [`#/lib/billing`](../../../../app/src/lib/billing/README.md). The app
only binds the Gateway log lookup from `#/lib/ai` that prices each request.

Each model request first creates an `ai_request` row. Its reservation includes
20% markup and conservatively bounds input tokens by UTF-8 request bytes plus
framing overhead, with 2,048 output tokens. Concurrent requests lock the user's
settings row and count both actual spend and outstanding reservations. The
cap defaults to $20 per user per UTC calendar month (pre-tax); setting it to $0 pauses AI.
When an organization pays, the request also locks the organization's settings row
and counts all spend and reservations on its Stripe customer against the shared
cap, $100 by default (pre-tax). A member cannot raise that cap with their own.
Applicable tax calculated by Stripe Tax is added on the invoice and does not
count toward these caps.
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
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run --cwd apps/app test:ai-billing
bun run --cwd apps/app build
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run --cwd apps/app test:ai-assistant
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
