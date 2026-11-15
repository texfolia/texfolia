# NAT-299 policy review

Status: draft for product-owner review. This document is not approved for publication.

Prepared on November 15, 2026 against `990686e` on main. The owner requested a source-backed draft in the NAT-299 working session. No approved Texfolia policy text was found in the issue, its comments, or the repository. The draft below describes implemented behavior. The open decisions at the end are still needed for complete release policies.

The public `/privacy` and `/terms` routes remain unchanged until the owner approves the final wording. The current fair-use paragraph is preserved verbatim below.

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

The owner of a personal project can grant view or edit access to another existing Texfolia account and can change or remove that access. Organization projects use organization membership for access. People with project access can see the project's files and the names, email addresses, and roles shown in its collaboration panel. Live collaboration shares presence and cursor information. Document history records contributor names and identifiers.

Removing access prevents further authorized access through Texfolia. It does not recall files or other copies that a collaborator has already downloaded or saved.

#### Published templates

Publishing a template creates a separate snapshot of saved project files, with a title, description, tags, license, and visibility setting. Reviewers can inspect submitted snapshots and reports. Approved public templates appear in the gallery. Approved unlisted templates are accessible to anyone who has their URL.

Template visitors can download the source archive or create an independent project copy. Changing or deleting the original project does not change the published snapshot or another person's project copy.

#### The AI assistant

When you use the managed assistant, your messages and conversation context are sent through Cloudflare AI Gateway to the selected model service. The assistant can list project files, read saved text files, edit text files, and request compilation. File contents and tool results used in the conversation form part of the model context. Assistant edits are saved and shared with collaborators immediately.

The conversation is held for the current page session, rather than saved as a chat history in Texfolia. Texfolia separately stores run and request records, including user and project identifiers, model, timestamps, token usage, costs, billing status, and the original payer. AI Gateway logging is enabled for usage reconciliation, with request and response payload storage disabled by the application.

#### Payments and service records

Texfolia uses Stripe for subscription checkout and AI usage billing. Texfolia stores Stripe customer and subscription identifiers, subscription state, and AI billing records. Stripe processes payment details through its checkout.

Operational logs and traces record requests, errors, and compilation activity. Compilation telemetry includes job identifiers, plan and engine information, timing, and outcomes. These records support operating the service, diagnosing failures, and reconciling usage.

#### Browser storage

Your browser stores appearance and editor preferences and workspace layout. For editors, Texfolia also caches collaborative text in IndexedDB to support reconnecting and offline edits. Closing a project or signing out does not automatically erase that local document cache. You can remove it by clearing Texfolia's site data in your browser. Clearing site data can discard edits that have not synchronized.

#### Document history, deletion, and retention

Unnamed text-document versions are retained for 30 days on all plans. Named versions remain until the project is deleted. History covers text content. It does not provide recovery of deleted files, binary files, or the folder structure. Versions of deleted text files become inaccessible and follow the same retention rules, including keeping named versions until project deletion.

Deleting a project removes access and starts cleanup of its saved sources, collaboration state, history, and generated build artifacts. Some cleanup runs in background jobs and retries after failures. Project and file metadata can remain marked as deleted in the database. Deletion does not mean immediate erasure of every related record or copy.

AI run and request billing records survive project deletion and are separate from document history. Texfolia currently has no self-service account deletion flow. Published template snapshots and independent copies have a separate lifecycle from the original project. Copies downloaded to other devices remain on those devices.

## Proposed terms copy

### Terms of service

Texfolia provides an online LaTeX workspace with project storage, compilation, document history, collaboration, templates, and a managed AI assistant. The following sections describe the current service behavior and compile fair-use policy. The owner decisions below must be resolved before this draft becomes complete release terms.

#### Accounts and access

Sign-in uses email codes or a supported identity provider. Personal-project owners manage access for existing accounts. Organization-project access follows organization membership. Viewers can read and download accessible content. Editors can change and save project files. Removing a collaborator's access does not remove copies they already hold.

#### Documents, history, and exports

You can export current project sources as a ZIP archive. Generated files can be included when a build exists. Text-document history retains unnamed versions for 30 days, with named versions kept until project deletion. History does not recover deleted files, binary files, or folder structure.

Project deletion starts server cleanup and removes access. Background cleanup can take additional time and retry failures. Export any files you want to keep before deleting the project. The privacy notice explains the different treatment of document data, browser copies, templates, and billing records.

#### Templates and licenses

Publishing creates an immutable snapshot of saved project files. Each submission requires confirmation that the publisher has the right to redistribute the included files under the selected license. Each snapshot is reviewed before public access. Public templates can appear in the gallery. Anyone with an approved unlisted template's URL can access it.

A template's displayed license applies to its source distribution. Downloading or copying a template creates a separate copy. Later changes to the original project do not update that copy or the published snapshot.

#### Subscriptions and AI usage

Stripe handles Pro subscription checkout. AI usage is billed separately from the plan price and compile allowances. Managed AI charges use the model request cost reported by Cloudflare AI Gateway, plus 20%. A failed or stopped assistant run can still include billable model requests. Usage reporting can finish after the run ends.

AI spending limits apply per user and per UTC calendar month. The default monthly limit is $20. Setting the limit to $0 pauses new AI usage. A request can be refused before the displayed limit is reached when its estimated maximum cost does not fit the remaining budget. Eligible organization usage is billed to the organization subscription selected for the run. Each run keeps its original payer even if membership or subscriptions change later.

#### Using the assistant

The assistant sends conversation context and the project content it reads to the selected model service through Cloudflare AI Gateway. Its file edits are saved immediately and shared with collaborators. Review its answers and changes before relying on them. Document history and project exports provide ways to inspect or keep supported text versions and current sources.

#### Fair use

Fair use applies to compilation on all plans. Compile timeouts and request rate limits depend on your plan. To keep Texfolia fast and available for everyone, sustained heavy compilation may be temporarily slowed or paused. You can try again after a short wait; access recovers automatically as recent activity decreases.

#### First-release scope

The first release includes the editor, compilation, document history, personal-project collaboration, reviewed templates, and the managed Pro assistant. Git integration is canceled. Organization creation, invitations, and membership administration have no management UI in v1. Existing organization invitations can still be accepted. Project renaming and duplication have no controls in v1.

## Owner decisions needed

These are unresolved decisions, not proposed commitments. They cannot be established by source inspection.

| Decision                                     | What the owner needs to supply or approve                                                                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator and contact                         | Legal operator name, location or address where appropriate, privacy and support contact channels, and effective date. The configured outbound `noreply@texfolia.com` address is not evidence of a monitored support inbox.                                            |
| Privacy requests and account deletion        | How a person requests access, correction, or account deletion; how identity is checked; who handles requests; and which records are retained. There is no account deletion implementation to point users to today.                                                    |
| Retention outside document history           | Approved periods and handling for account and session records, deleted metadata, operational logs, backups, and billing records. Source code does not establish an overall erasure deadline.                                                                          |
| Providers and processing locations           | Actual production database host, processing locations, provider list and applicable agreements. Confirm the selected AI services' retention and training practices. The Gateway payload flag does not establish those providers' policies.                            |
| Privacy commitments and required disclosures | Applicable privacy rights and request process, disclosures about legal demands or business transfers, and any commitments about selling data, advertising, or AI training. No certification, compliance, residency, or end-to-end encryption claim has been inferred. |
| Content rights and service permission        | Ownership wording and the permission Texfolia needs to store, process, compile, share, and publish user content. Template license selection alone does not establish a general service license.                                                                       |
| Eligibility and acceptable use               | Age or other eligibility rules, account responsibilities, prohibited use, abuse handling, suspension, termination, and the process for content or copyright complaints.                                                                                               |
| Subscription terms                           | Approved price and currency wording, renewal and cancellation behavior, refunds, taxes, failed payments, plan changes, and payment disputes. Keep Team checkout and unenforced plan caps aligned with NAT-283.                                                        |
| AI terms                                     | Approve the implemented separate billing and markup disclosure, responsibility for AI output, provider conditions, and handling of billing errors.                                                                                                                    |
| Remaining legal terms                        | Warranty and availability language, liability, dispute handling, governing law, and how policy or service changes are announced. No legal jurisdiction or liability limit has been selected by the agent.                                                             |

## Implementation evidence

These links support the factual draft. They are not evidence of legal approval or deployed provider configuration.

| Subject                                                                            | Source                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in methods, email codes, Turnstile, Stripe, no account deletion configuration | [Auth configuration](../../apps/web/src/lib/auth.ts), [auth behavior inventory](../auth-abuse-protection.md)                                                                                                                     |
| Stored account, provider-token, session, organization, and subscription fields     | [Auth database schema](../../packages/db/src/auth-schema.ts)                                                                                                                                                                     |
| Email delivery                                                                     | [Email adapter](../../apps/web/src/lib/email.ts)                                                                                                                                                                                 |
| Project deletion and build cleanup                                                 | [Project service](../../apps/web/src/lib/project.server.ts), [source collector](../../apps/web/src/lib/project-source.server.ts), [collaboration collector](../../apps/web/src/lib/collaboration/cleanup.server.ts)              |
| Sharing names, email addresses, and roles                                          | [Sharing service](../../apps/web/src/lib/project-sharing.server.ts)                                                                                                                                                              |
| Browser text cache and its lifecycle                                               | [Collaborative file](../../apps/web/src/lib/collaboration/file.ts)                                                                                                                                                               |
| Preferences and workspace layout                                                   | [Settings storage](../../apps/web/src/lib/settings.functions.ts), [theme provider](../../apps/web/src/providers/theme-provider.tsx), [workspace](../../apps/web/src/routes/project/$projectId/-components/project-workspace.tsx) |
| History duration and cleanup                                                       | [History policy](../../apps/web/src/lib/document-history.ts), [history behavior](../document-history.md)                                                                                                                         |
| Template snapshots, review, license confirmation, and retention                    | [Template lifecycle](../templates.md), [template validation](../../apps/web/src/lib/template.schema.ts)                                                                                                                          |
| AI context, immediate edits, Gateway payload flag, and run lifecycle               | [Assistant service](../../apps/web/src/lib/ai/chat.server.ts), [assistant tools](../../apps/web/src/lib/ai/tools.server.ts)                                                                                                      |
| AI charging, caps, and retained payer records                                      | [AI billing setup](../ai-assistant.md), [AI schema](../../packages/db/src/schema.ts)                                                                                                                                             |
| Cloudflare infrastructure and operational logs                                     | [Web Worker configuration](../../apps/web/wrangler.jsonc), [compile telemetry](../compile-telemetry.md)                                                                                                                          |
| Current fair-use wording                                                           | [Terms route](../../apps/web/src/routes/terms/route.tsx)                                                                                                                                                                         |
| v1 controls and deferred features                                                  | [Project controls](../project-controls.md)                                                                                                                                                                                       |

## v1 UI and content pass

NAT-299 remains a release requirement under [NAT-286](https://linear.app/nbaby/issue/NAT-286). [NAT-283](https://linear.app/nbaby/issue/NAT-283) follows it and owns pricing copy and plan claims.

- [x] Inventory implemented account, document, collaboration, storage, billing, and service behavior.
- [x] Prepare factual privacy and terms copy for owner review.
- [ ] Obtain the owner's missing policy decisions and approval of complete release wording.
- [ ] Replace the public privacy notice and incomplete terms with the approved copy.
- [ ] Verify the complete approved content on both rendered routes at desktop and mobile sizes, including policy links and navigation.

The current shared footer links to Privacy and Terms, and the sign-in page links to both routes. Pricing links to the compile fair-use terms. Those links already exist on main.

Current-page verification on November 15, 2026 passed against the production build served by a local Worker:

- `bun run --cwd apps/web build` completed successfully.
- Both existing policy pages rendered at 1440, 375, and 320 pixels without horizontal overflow or browser page errors. Desktop and mobile captures were inspected.
- Footer links opened both routes. Keyboard activation of the Terms link worked.
- Sign-in links had the correct policy destinations, and its Privacy link opened the privacy route.
- Pricing's **fair use** link opened the terms route.
- The rendered fair-use paragraph matched the existing source. The draft preserves that paragraph verbatim.
- Repository Markdown-link checks, formatting checks for the changed documents, and `git diff --check` passed.

These checks cover the current unfinished pages. They do not establish completion of the approved policy content.
