# Project controls in v1

Personal projects support collaboration with existing Texfolia accounts. The owner manages access in the workspace's **Collaboration** panel.

| Control          | v1 behavior                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open project     | The project name and labeled open link lead to the workspace.                                                                                                                      |
| Delete project   | The owner can delete a personal project after confirmation. Collaborators have no delete control.                                                                                  |
| Copy project     | No control is shown. Project duplication is outside v1.                                                                                                                            |
| Rename project   | No control is shown. Project renaming is outside v1.                                                                                                                               |
| Download project | **Export project** in the Files sidebar downloads a ZIP of current sources. Generated files are optional when a build exists.                                                      |
| Share project    | The owner grants **Can view** or **Can edit** by account email. Sharing does not send an email invitation or create an account.                                                    |
| Share links      | The owner creates read-only links for people without an account: **Sources and PDF**, or **PDF only**. See [Share links](#share-links).                                            |
| Change access    | Sharing with the same email updates that person's role.                                                                                                                            |
| Revoke access    | **Remove** revokes a collaborator's access. The project disappears from their project list, and their open workspace loses access.                                                 |
| File management  | Editors can create files and folders, upload source files, and rename, move, or delete items. Deletion requires confirmation. Viewers have no source management controls.          |
| Access display   | The project list shows the actual collaborator count, **Personal** when there are none, or **Organization** for inherited membership. The workspace lists actual people and roles. |

Organization projects inherit access from membership. Every organization member is an editor on every organization project, whatever their role (`owner`, `admin`, or `member`). Members can save sources, compile, write to collaboration, and use write assistant tools. Organization projects have no viewer role and no per-project roles. Owners and admins additionally can delete organization projects and link or unlink a git remote. The workspace explains this and shows no personal-project sharing form. Organization creation, invitations, and membership administration have no management UI in v1. The invitation acceptance route remains available for existing invitations.

The public header links to Templates and Pricing. GitHub and GitLab integration is available from the right sidebar. Repositories can be imported from Projects. The Pro AI assistant is part of v1.

## Share links

The owner of a personal project manages share links in the **Collaboration** panel. Anyone with a link can view without signing in, at `/share/<token>`. Organization projects have no share links in v1.

- **Sources and PDF** shows the file tree, read-only sources with live edits from the collaboration room, and the latest PDF.
- **PDF only** shows the latest PDF and the live build state. It cannot read sources, build logs, job status, or other generated files.
- Links never write: they cannot edit, save, compile, or change metadata.
- A project has at most 10 links. The full link is shown once, when it is created; only a SHA-256 hash of its token is stored. Copy it then, or create another.
- **Revoke** deletes a link. Open collaboration sockets close immediately and live build streams stop within the access re-check interval. Deleting the project disables its links.

Decisions on the open questions in NAT-390:

- Guests have no presence. Their cursors are not shown to collaborators, and they do not see collaborators’ cursors or names in the editor. A build’s `builtBy` name is still part of the build state.
- Links do not expire. Revoke a link when it is no longer needed.

Server-side, a link acts as the principal `share:<linkId>` wherever a user ID is checked. `lockProject` resolves it against `project_share_link`, rejects writes, and rejects PDF-only links unless the caller asks for build content. API requests carry the token in the `share` query parameter, which takes precedence over the session.

## Release policy content

NAT-299 remains open in the v1 UI and content pass. The privacy and terms pages
now show general templates with prominent placeholder notices, unset effective
dates, and sections marked **To be completed**. Final policies still need
product-owner approval before release. The
[policy review draft](release/nat-299-policy-review.md) records source-backed copy,
the missing owner decisions, and the remaining release checks. Privacy and Terms
are already linked from the shared footer and sign-in page.

## Verification

`apps/web/test/compile-route.ts` covers share-link build access, PDF-only limits, rejected writes, and revocation. `apps/web/test/collaboration.ts` covers guest sockets: read-only sync, live edits, no presence, PDF-only rejection, and live revocation of sockets and build streams.

`apps/web/test/ui-overhaul.ts` exercises authenticated project creation, listing, opening, deletion, sharing errors, grants, role changes in both directions, live revocation, file management, and ZIP export. Keyboard checks cover navigation, file action dialogs, focus restoration, access removal, saving, and export. Public pages and the workspace are captured at desktop and mobile sizes. CI runs this suite against an isolated Postgres test database and local Worker services after the web build. `bun run --cwd apps/web test:ui` builds the app and runs the same checks locally when `INTEGRATION_DATABASE_URL` points to an isolated database with the current schema and `test` in its name.
