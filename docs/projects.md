# Projects dashboard

The authenticated `/projects` page uses the app theme and an inset sidebar.
Recent projects are the six accessible projects with the latest `updatedAt`.
The account menu links to the same settings pages as `/settings`. Signing out
requires confirmation.

**New project** opens three choices: Template, Git repository, and Files or folder.
The default shortcut is **N**, then **P**. The shortcut editor in Preferences
can change this sequence. Sequences are ignored in inputs and editors.

The template choice includes Blank, which creates an empty `main.tex`. Approved
public templates are paginated inside the dialog. Template copies accept a
project name and personal or organization destination through `openTemplate`.
The existing collision suffix behavior also applies to a supplied name.
The public gallery, publishing, review, and stable snapshot pages remain available.

Git imports use the existing GitHub and GitLab connection flow. Returning from
account authorization restores the import dialog and its draft repository URL.
Files and folder imports preserve relative paths, accept at most 400 files,
and reuse the workspace limits: 10 MiB per file and 50 MiB per project.
Uploads validate paths, case-insensitive collisions, and UTF-8 text before
creating project metadata. Failed imports roll back the entire project.
Unreferenced R2 objects follow the existing source cleanup lifecycle.

Tags belong to each user. `tag` has a unique `(userId, name)` key, and
`project_tag` assigns those tags to projects. Only the current user's tags are
returned in the project list. Anyone who can read a project can manage their
own labels, including viewers. Changing labels does not change the project's
`updatedAt` or another user's labels. Tag names are normalized to lowercase;
a project accepts up to 12 labels, each at most 32 characters.

The TanStack Table filters the loaded set by name and private tag, and sorts
by project name, collaborator count, tags, or update time in the browser.
Collaborators include the personal owner and explicit collaborators, or the
organization's members. Row menus provide Open, Rename, Your tags, Share,
Download ZIP, and Delete. Rename uses existing write access, sharing retains
its existing owner rules, and deletion is available to personal owners and
organization owners or admins. Downloads contain saved sources.

Schema changes use local `db:push` during development. Deployment requirements
are in [Database deployment](database-deployment.md).
The optional PDF cover preview is not part of this implementation.

## Verification

Apply the schema to an isolated local database whose name includes `test`:

```sh
DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run db:push
```

Run the upload and permission regression checks:

```sh
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run apps/app/test/projects.ts
```

Build the app and run the rendered dashboard and workspace suite:

```sh
bun run --cwd apps/app build
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run apps/app/test/ui-overhaul.ts
```
