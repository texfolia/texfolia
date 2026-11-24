# Git integration

Projects can import a public or private GitHub or gitlab.com repository. The Git
view in the switchable right sidebar links an existing project to an empty remote, shows
working changes and a diff, records manual commits, pushes and pulls, and lists,
creates, and checks out branches. Refresh git to discover newly created remote
branches. Empty repositories start on `main`. Existing repositories retain their
default branch. Linking refuses nonempty remotes; import those from Projects.

## Integrations only

Texfolia does not host Git repositories (NAT-413). Git always works through a
repository on an integrated platform. The platform is the source of truth for
history. Git is optional: editing, compilation, collaboration, export and the
assistant work without a `project_git` row. A project without one offers only the
empty-remote link flow; import creates a new project from an existing remote.

Projects initialized before NAT-413 may still have a Texfolia-hosted repository
(`project_git.provider` and `url` are null). Its status and diff stay readable, so
the history is visible. Every other action is refused except two. **Link** an empty
remote adds `origin` and keeps the local commits and branches so they can be
pushed. **Unlink** (shown as **Remove stored history**) discards them. The status
bar shows no branch for these repositories.

## Platform adapters

The core Git module lives in [`#/features/git`](../apps/app/src/features/git/README.md)
(`schema.ts`, `actions.ts`, `repository.ts`) and speaks plain Git smart HTTP
through isomorphic-git. Each platform is an adapter in
`apps/app/src/features/git/providers/` that supplies:
its Better Auth provider ID, label, HTTPS host, OAuth repository scopes, the
username sent with the token, which URL paths name a repository, and an example
URL. Remote URL validation, account checks, the remote form, the Git view and
Settings → Connections all read the registry in `providers/index.ts`.

To add a platform, such as Cursor Origin or Bitbucket: register its OAuth
provider in `apps/app/src/features/auth/auth.ts`, write an adapter, and add it to `gitProviders`.
Platforms whose Git HTTP differs from GitHub and GitLab (for example, a token
that is not sent as basic authentication) need a new adapter field.

## Accounts and credentials

Git uses the existing Better Auth GitHub and GitLab accounts. Connect requests
additional scopes with `authClient.linkSocial`: GitHub `repo`, GitLab
`read_repository` and `write_repository`. Email users link the provider once.
Repository permission is requested only when connecting git. The provider controls
which repositories an account can access. GitLab self-hosted instances are not
supported.

GitHub incremental authorization requires an OAuth App. GitHub Apps use permissions from their registration instead of OAuth scope requests. Set the existing `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` and
`GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` in local development and deployment.
Both registrations use Better Auth's existing callback URLs. GitLab must allow the
repository scopes. Better Auth encrypts tokens in its account table and refreshes them on the server. Git functions return no tokens. Better Auth disables the public token retrieval and refresh endpoints. Reconnect an account to renew
permissions after revocation or scope changes.

Each user uses their own provider credentials; a collaborator never borrows the
owner's token. Owners and organization admins manage remote linking. Writers can
commit; push, pull, and remote checkout additionally require repository access.
Viewers can read status, changes, and commits.

## Storage and collaboration

`project_git` points to an immutable `git/<projectId>/<id>.json` R2 object containing
real git objects, refs, configuration, and index. PostgreSQL project nodes and
content-addressed R2 sources are the working tree. Project locks serialize git
with metadata and source writes; the collaboration Durable Object serializes git
with Yjs updates and flushes accepted live edits before reading sources.

Git actions snapshot the project rows in a short locked transaction, read
repository and source objects from R2 and talk to the Git host with no database
lock held, then apply results in a second short transaction. If the repository
pointer, or for import, pull, and checkout any project node, changed in between,
nothing is applied and the action asks the user to retry.

Pull and checkout replace sources atomically with the repository pointer. File
IDs survive for unchanged paths. Open text documents receive a new CRDT edit; a
room interrupted after SQL commit reconciles from the source pointer on its next
use. Offline edits still merge when the client reconnects. The editor waits for
open files to reconnect and save before issuing git actions.

Commits honor nested `.gitignore` rules. Tracked files keep normal git semantics.
Generated `out/` content is excluded from new commits and project sources. Symbolic
links, submodules, and case-colliding paths cannot be imported. Source limits remain
10 MiB per file and 50 MiB per project, with at most 1,000 imported files. Git
transfers and stored repository data are capped at 20 MiB. Imports shallow-clone
50 commits to bound resource usage; earlier history stays on the host.

Pull requires a clean working tree and can merge nonconflicting commits. A conflict
returns the affected paths and preserves the working tree and repository pointer.
Resolve conflicts on the host or in a local checkout, then pull again. Push never
forces history. Visual merge editing and pull/merge request creation are outside
this implementation.

Unlink keeps files and discards local git history and branches. Push first to keep
commits on the host. The hourly source sweep deletes superseded and abandoned git
objects. Project deletion removes local git data; it never deletes the remote.
Prelaunch document snapshots are removed without migration: the room drops its
history tables and the registered-room sweep deletes legacy `history/` R2 objects.
Live Yjs persistence remains.

## Assistant

The Pro assistant exposes git status, diff, commit, push, pull, branch creation,
and checkout tools. The assistant instructions require an explicit user request before git mutations.
The Generate message button uses the same Gateway, subscription, spending cap,
and metering as chat, with no mutation tools. The suggested message remains editable. Choosing **Commit changes** creates the commit. Commit-message drafts remain in session storage when the mobile sidebar closes.

## Verification

`bun test apps/app/src/features/git` runs real git HTTP transport
against the installed `git-http-backend`, including authentication, binary imports,
ignore rules, commits, push/pull, branches, conflicts, and persisted repository data.

Use an isolated PostgreSQL database for the Worker, R2, and collaboration tests:

```sh
DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_git_test bun run --cwd packages/db db:push
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_git_test bun run --cwd apps/app test:git
```

The Worker integration uses real PostgreSQL, R2, Yjs rooms, and git HTTP transport.
Only OAuth tokens and the remote host are test fixtures. Real provider consent and
hosted private repositories require a separate smoke test with real accounts.
