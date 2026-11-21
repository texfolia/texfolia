# NAT-299 policy review

Status: placeholder templates implemented for review. Final release policies are not approved.

Originally prepared on November 15, 2026 against `990686e` on main. Refreshed on November 16 against `1edcc41` for saved assistant chats, account deletion, optional local Git history, and the release work order. No approved final Texfolia policy text was found in the issue, its comments, or the repository. The draft below describes implemented behavior. The open decisions at the end are still needed for complete release policies.

On November 16, the owner requested general templates directly on `/privacy` and `/terms`, with their placeholder status made clear. Both pages now show an unapproved-template notice, an unset effective date, product descriptions, and explicit **To be completed** sections. Their page titles identify them as templates, and both routes send `noindex, nofollow` metadata while unfinished. This instruction approves the template presentation, not final legal commitments. The existing fair-use paragraph is preserved verbatim.

The route templates organize the factual material below with prompts for the unresolved decisions. Before release, replace those prompts and the placeholder notice with the approved wording, set the effective date, update the page titles, and remove the placeholder indexing restriction.

## Proposed privacy copy

### Privacy

Texfolia is an online LaTeX workspace. This notice describes the information used for accounts, projects, collaboration, compilation, templates, and the managed AI assistant.

#### Accounts and sign-in

Texfolia stores your name, email address, email verification status, profile image when supplied, and account timestamps. You can sign in with an emailed code or through GitHub, Google, GitLab, or Microsoft. A connected sign-in account can include provider identifiers and authentication tokens. Existing password accounts can also sign in and reset their passwords.

Sessions use cookies. Session records include an expiry time and can include your IP address and browser information. Texfolia sends sign-in and password-reset codes by email. Cloudflare Turnstile checks email-code requests to help prevent abuse.

#### Projects, documents, and compilation

Texfolia stores project names, file names and folder structure, text documents, uploaded files, and access permissions. It processes your saved sources to compile documents and display PDFs, compilation logs, and generated files.

Project metadata and account records are stored in a database. Source files, document versions, and generated artifacts use server storage. Live collaboration also stores synchronized document state. Cloudflare services provide application hosting, object storage, collaboration infrastructure, email delivery, and compilation infrastructure.

#### Collaboration and sharing

The owner of a personal project can grant view or edit access to another existing Texfolia account and can change or remove that access. Organization projects use organization membership for access. People with project access can see the project's files and the names, email addresses, and roles shown in its collaboration panel. Live collaboration shares presence and cursor information. Git commits record author names and email addresses.

Removing access prevents further authorized access through Texfolia. It does not recall files or other copies that a collaborator has already downloaded or saved.

#### Published templates

Publishing a template creates a separate snapshot of saved project files, with a title, description, tags, license, and visibility setting. Reviewers can inspect submitted snapshots and reports. Approved public templates appear in the gallery. Approved unlisted templates are accessible to anyone who has their URL.

Template visitors can download the source archive or create an independent project copy. Changing or deleting the original project does not change the published snapshot or another person's project copy.

#### The AI assistant

When you use the managed assistant, your messages and conversation context are sent through Cloudflare AI Gateway to the selected model service. The assistant can list project files, read saved text files, edit text files, and request compilation. File contents and tool results used in the conversation form part of the model context. Assistant edits are saved and shared with collaborators immediately.

Chats are saved on the server for each user and project. Stored content includes conversation titles, model choices, messages, tool calls and results, and model reasoning when returned. Chat history lets users delete individual conversations. Texfolia separately stores run and request records, including user and project identifiers, model, timestamps, token usage, costs, billing status, and the original payer. AI Gateway logging is enabled for usage reconciliation, with request and response payload storage disabled by the application.

#### Payments and service records

Texfolia uses Stripe for subscription checkout and AI usage billing. Texfolia stores Stripe customer and subscription identifiers, subscription state, and AI billing records. Stripe processes payment details through its checkout.

Operational logs and traces record requests, errors, and compilation activity. Compilation telemetry includes job identifiers, plan and engine information, timing, and outcomes. These records support operating the service, diagnosing failures, and reconciling usage.

#### Browser storage

Your browser stores appearance and editor preferences and workspace layout. For editors, Texfolia also caches collaborative text in IndexedDB to support reconnecting and offline edits. Closing a project keeps this cache. After a warning, signing out removes your account's cached collaborative text and workspace layouts, which can contain Markdown previews. It also removes legacy recovery drafts shared across accounts. This includes unsynced edits. Save those edits while connected before signing out. Saved documents can be downloaded again after sign-in. Appearance and editor preferences remain. If removal fails, Texfolia shows an error so you can retry or clear Texfolia's site data in your browser.

#### Git history, deletion, and retention

Version history uses an optional Git repository stored on Texfolia, with or without a linked GitHub or GitLab remote. Commits record project files, including binary files and folder changes. Push commits to keep them on your repository host. Unlinking removes Texfolia's repository data and keeps current project files. Copies pushed to a repository host follow that host's retention and access policies.

Deleting a project removes access and starts cleanup of its saved sources, collaboration state, history, and generated build artifacts. Some cleanup runs in background jobs and retries after failures. Project and file metadata can remain marked as deleted in the database. Project deletion sets `deletedAt` rather than deleting the project row, so the database cascade does not remove its saved chat rows. Deletion does not mean immediate erasure of every related record or copy.

Account settings includes an account deletion flow confirmed through an email link. The database schema cascades user deletion to personal projects and the user's saved chats. AI run and request billing records survive account and project deletion. Published template snapshots and independent copies have a separate lifecycle from the original project. Copies downloaded to other devices remain on those devices. The schema and cleanup jobs do not establish an overall erasure deadline.

## Proposed terms copy

### Terms of service

Texfolia provides an online LaTeX workspace with project storage, compilation, git version history, collaboration, templates, and a managed AI assistant. The following sections describe the current service behavior and compile fair-use policy. The owner decisions below must be resolved before this draft becomes complete release terms.

#### Accounts and access

Sign-in uses email codes or a supported identity provider. Personal-project owners manage access for existing accounts. Organization-project access follows organization membership. Viewers can read and download accessible content. Editors can change and save project files. Removing a collaborator's access does not remove copies they already hold.

#### Documents, history, and exports

You can export current project sources as a ZIP archive. Generated files can be included when a build exists. Git commits can preserve project files and folder structure. Push commits to keep a copy on GitHub or GitLab.

Project deletion starts server cleanup and removes access. Background cleanup can take additional time and retry failures. Export any files you want to keep before deleting the project. The privacy notice explains the different treatment of document data, browser copies, templates, and billing records.

#### Templates and licenses

Publishing creates an immutable snapshot of saved project files. Each submission requires confirmation that the publisher has the right to redistribute the included files under the selected license. Each snapshot is reviewed before public access. Public templates can appear in the gallery. Anyone with an approved unlisted template's URL can access it.

A template's displayed license applies to its source distribution. Downloading or copying a template creates a separate copy. Later changes to the original project do not update that copy or the published snapshot.

#### Subscriptions and AI usage

Stripe handles Pro subscription checkout. AI usage is billed separately from the plan price and compile allowances. Managed AI charges use the model request cost reported by Cloudflare AI Gateway, plus 20%. A failed or stopped assistant run can still include billable model requests. Usage reporting can finish after the run ends.

AI spending limits apply per user and per UTC calendar month. The default monthly limit is $20. Setting the limit to $0 pauses new AI usage. A request can be refused before the displayed limit is reached when its estimated maximum cost does not fit the remaining budget. Eligible organization usage is billed to the organization subscription selected for the run. Each run keeps its original payer even if membership or subscriptions change later.

#### Using the assistant

The assistant sends conversation context and the project content it reads to the selected model service through Cloudflare AI Gateway. Its file edits are saved immediately and shared with collaborators. Chats are saved for each user and project and can be deleted from chat history. Review its answers and changes before relying on them. Git commits and project exports provide ways to keep versions and current sources.

#### Fair use

Fair use applies to compilation on all plans. Compile timeouts and request rate limits depend on your plan. To keep Texfolia fast and available for everyone, sustained heavy compilation may be temporarily slowed or paused. You can try again after a short wait; access recovers automatically as recent activity decreases.

#### First-release scope

The templates describe the implemented editor, compilation, optional Git history and remote integration, personal-project collaboration, reviewed templates, and managed assistant. They do not promise planned compile-engine options or other unimplemented features. Organization creation, invitations, and membership administration have no management UI in v1. Existing organization invitations can still be accepted. Project renaming is available from the projects table. Project duplication has no controls in v1.

## Owner decisions needed

These are unresolved decisions, not proposed commitments. They cannot be established by source inspection.

| Decision                                     | What the owner needs to supply or approve                                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator and contact                         | Legal operator name, location or address where appropriate, privacy and support contact channels, and effective date. The configured outbound `noreply@texfolia.com` address is not evidence of a monitored support inbox.                                              |
| Privacy requests and account deletion        | Approve how people request access or correction, identity checks, who handles requests, and which records remain. Account settings now provides email-confirmed deletion; that flow does not establish the remaining privacy-request process or retention policy.       |
| Retention outside document history           | Approved periods and handling for account and session records, saved chats, deleted metadata, operational logs, backups, and billing records. Project soft deletion leaves saved chat rows in the database. Source code does not establish an overall erasure deadline. |
| Providers and processing locations           | Actual production database host, processing locations, provider list and applicable agreements. Confirm the selected AI services' retention and training practices. The Gateway payload flag does not establish those providers' policies.                              |
| Privacy commitments and required disclosures | Applicable privacy rights and request process, disclosures about legal demands or business transfers, and any commitments about selling data, advertising, or AI training. No certification, compliance, residency, or end-to-end encryption claim has been inferred.   |
| Content rights and service permission        | Ownership wording and the permission Texfolia needs to store, process, compile, share, and publish user content. Template license selection alone does not establish a general service license.                                                                         |
| Eligibility and acceptable use               | Age or other eligibility rules, account responsibilities, prohibited use, abuse handling, suspension, termination, and the process for content or copyright complaints.                                                                                                 |
| Subscription terms                           | Approved price and currency wording, renewal and cancellation behavior, refunds, taxes, failed payments, plan changes, and payment disputes. Keep Team checkout and unenforced plan caps aligned with NAT-283.                                                          |
| AI terms                                     | Approve the implemented separate billing and markup disclosure, responsibility for AI output, provider conditions, and handling of billing errors.                                                                                                                      |
| Remaining legal terms                        | Warranty and availability language, liability, dispute handling, governing law, and how policy or service changes are announced. No legal jurisdiction or liability limit has been selected by the agent.                                                               |

## Implementation evidence

These links support the factual draft. They are not evidence of legal approval or deployed provider configuration.

| Subject                                                                               | Source                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in methods, email codes, Turnstile, Stripe, and email-confirmed account deletion | [Auth configuration](../../apps/app/src/lib/auth.ts), [account settings](../../apps/app/src/routes/settings/account/route.tsx)                                                                                                   |
| Stored account, provider-token, session, organization, and subscription fields        | [Auth database schema](../../packages/db/src/auth-schema.ts)                                                                                                                                                                     |
| Email delivery                                                                        | [Email adapter](../../apps/app/src/lib/email.ts)                                                                                                                                                                                 |
| Project deletion and build cleanup                                                    | [Project service](../../apps/app/src/lib/project.server.ts), [source collector](../../apps/app/src/lib/project-source.server.ts), [collaboration collector](../../apps/app/src/lib/collaboration/cleanup.server.ts)              |
| Sharing names, email addresses, and roles                                             | [Sharing service](../../apps/app/src/lib/project-sharing.server.ts)                                                                                                                                                              |
| Browser text cache and its lifecycle                                                  | [Collaborative file](../../apps/app/src/lib/collaboration/file.ts)                                                                                                                                                               |
| Preferences and workspace layout                                                      | [Settings storage](../../apps/app/src/lib/settings.functions.ts), [theme provider](../../apps/app/src/providers/theme-provider.tsx), [workspace](../../apps/app/src/routes/project/$projectId/-components/project-workspace.tsx) |
| Optional local Git history, remote credentials, and cleanup                           | [Git service](../../apps/app/src/lib/git.server.ts), [Git behavior](../git-integration.md)                                                                                                                                       |
| Template snapshots, review, license confirmation, and retention                       | [Template lifecycle](../templates.md), [template validation](../../apps/app/src/lib/template.schema.ts)                                                                                                                          |
| AI context, immediate edits, Gateway payload flag, and run lifecycle                  | [Assistant service](../../apps/app/src/lib/ai/chat.server.ts), [assistant tools](../../apps/app/src/lib/ai/tools.server.ts)                                                                                                      |
| Saved chat ownership, deletion, and database cascades                                 | [Chat service](../../apps/app/src/lib/ai/threads.server.ts), [message schema](../../apps/app/src/lib/ai/threads.ts), [database schema](../../packages/db/src/schema.ts)                                                          |
| AI charging, caps, and retained payer records                                         | [AI billing setup](../ai-assistant.md), [AI schema](../../packages/db/src/schema.ts)                                                                                                                                             |
| Cloudflare infrastructure and operational logs                                        | [App Worker configuration](../../apps/app/wrangler.jsonc), [compile telemetry](../compile-telemetry.md)                                                                                                                          |
| PostgreSQL through Hyperdrive; production provisioning remains a deployment decision  | [Database deployment guide](../database-deployment.md), [database package](../../packages/db/README.md)                                                                                                                          |
| Current fair-use wording                                                              | [Terms page](../../apps/web/src/pages/terms.astro)                                                                                                                                                                               |
| v1 controls and deferred features                                                     | [Project controls](../project-controls.md)                                                                                                                                                                                       |

## v1 UI and content pass

NAT-299 remains a release requirement under [NAT-286](https://linear.app/nbaby/issue/NAT-286). The November 16 work order places it after [NAT-318](https://linear.app/nbaby/issue/NAT-318), now Done in Linear, and before [NAT-302](https://linear.app/nbaby/issue/NAT-302). [NAT-283](https://linear.app/nbaby/issue/NAT-283) owns pricing copy and plan claims.

- [x] Inventory implemented account, document, collaboration, storage, billing, and service behavior.
- [x] Prepare factual privacy and terms copy for owner review.
- [x] Put clearly labeled general templates on both routes, as requested by the owner on November 16.
- [x] Verify the placeholder content, section navigation, and policy links at desktop and mobile sizes.
- [ ] Obtain the owner's missing policy decisions and approval of complete release wording.
- [ ] Replace the public privacy notice and incomplete terms with the approved copy.
- [ ] Verify the complete approved content on both rendered routes at desktop and mobile sizes, including policy links and navigation.

The current shared footer links to Privacy and Terms, and the sign-in page links to both routes. Pricing links to the compile fair-use terms. Those links already exist on main.

## Template verification

On November 16, 2026, the production build was served by an isolated local Worker and checked in headless Chromium:

- `bun run --cwd apps/app build` and `bun run --cwd apps/app typecheck` passed.
- Both templates rendered at 1440, 768, 375, and 320 pixels without horizontal overflow or browser page errors. Desktop and mobile captures were inspected.
- Both pages rendered their placeholder notices and all policy sections with JavaScript disabled.
- Placeholder notices, unset effective dates, template page titles, and `noindex, nofollow` metadata were present.
- Every contents link had a unique, correctly labeled section target. Keyboard activation of **Fair use** scrolled to its section, with a visible focus outline before activation.
- Policy cross-links and shared footer links opened the expected routes. Sign-in links had the correct destinations, and its Privacy link opened the privacy template. Pricing's **fair use** link opened the terms template.
- The rendered fair-use paragraph matched the paragraph on `1edcc41`, ignoring source whitespace.
- Targeted Oxlint, Oxfmt checks, `bun run check:repo`, and `git diff --check` passed. The Impeccable detector reported no findings in the changed UI files.

These checks cover the requested placeholders. Final wording, owner approval, and the release checks above remain outstanding. No production deployment was performed.
