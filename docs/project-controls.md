# Project controls in v1

Personal projects support collaboration with existing Texfolia accounts. The owner manages access in the workspace's **Collaboration** panel.

| Control            | v1 behavior                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open project       | The project name and labeled open link lead to the workspace.                                                                                                                                                                               |
| Delete project     | The owner moves a personal project to the trash and can restore it for 30 days or delete it permanently. Collaborators have no delete control. See [Trash](#trash).                                                                         |
| Duplicate project  | Anyone signed in who can read a project can copy it into a new personal project. See [Duplicates](#duplicates).                                                                                                                             |
| Transfer ownership | The owner can make a collaborator the owner. See [Ownership transfer](#ownership-transfer).                                                                                                                                                 |
| Rename project     | No control is shown. Project renaming is outside v1.                                                                                                                                                                                        |
| Download project   | **Export project** in the Files sidebar downloads a ZIP of current sources. Generated files are optional when a build exists.                                                                                                               |
| Share project      | The owner grants **Can view** or **Can edit** by account email. Adding a new collaborator emails them a link to open the project; changing an existing collaborator's role does not send another email. Sharing does not create an account. |
| Share links        | The owner creates read-only links for people without an account: **Sources and PDF**, or **PDF only**. See [Share links](#share-links).                                                                                                     |
| Change access      | Sharing with the same email updates that person's role.                                                                                                                                                                                     |
| Revoke access      | **Remove** revokes a collaborator's access. The project disappears from their project list, and their open workspace loses access.                                                                                                          |
| File management    | Editors can create files and folders, upload source files, and rename, move, or delete items. Deletion requires confirmation. Viewers have no source management controls.                                                                   |
| Review comments    | Everyone with access, including viewers, can comment on a passage, reply, and resolve or reopen threads. See [Review comments](#review-comments).                                                                                           |
| Access display     | The project list shows the actual collaborator count, **Personal** when there are none, or **Organization** for inherited membership. The workspace lists actual people and roles.                                                          |

Organization projects inherit access from membership. Every organization member is an editor on every organization project, whatever their role (`owner`, `admin`, or `member`). Members can save sources, compile, write to collaboration, and use write assistant tools. Organization projects have no viewer role and no per-project roles. Owners and admins additionally can trash, restore, permanently delete, and transfer organization projects, and link or unlink a git remote. The workspace explains this and shows no personal-project sharing form. Organization creation, invitations, and membership administration have no management UI in v1. The invitation acceptance route remains available for existing invitations.

The public header links to Templates and Pricing. GitHub and GitLab integration is available from the right sidebar. Repositories can be imported from Projects. The Pro AI assistant is part of v1.

## Trash

Deleting a project moves it to **Trash** in the Projects sidebar. The project
closes for everyone: it leaves project lists, its share links stop working, and
open collaboration sockets and build streams close.

- The personal owner, or an organization owner or admin, sees the project in the trash, restores it, or deletes it permanently. Collaborators, other members, and share-link visitors cannot.
- Restoring brings back its files, collaborators, share links, comments, chats, tags, and Git link. Builds are not kept, so compile again. If the owner has reused the name, the restored project gets a numeric suffix.
- **Delete permanently** removes the project row and everything stored with it, then its sources, collaboration documents, and Git clone. It cannot be undone, and it never touches the Git remote, published templates, or duplicates.
- Projects are permanently deleted after 30 days in the trash, by the hourly scheduled run.

Server-side, `project.deleted_at` means the project is in the trash. Storage
cleanup keys on the row instead: sources, collaboration rooms, and Git clones
are collected only once the row is gone. Edits accepted just before a project is
trashed are still saved. A project that was soft-deleted before the trash
existed may appear there, but its sources were already collected, so it cannot
be opened after restoring.

## Duplicates

**Duplicate** copies the saved files, folders, formatting, and spelling settings
into a new personal project named “… copy”. This also applies to organization
projects: the copy belongs to the person who made it. Collaborators, share
links, comments, chats, tags, the Git remote, and builds are not copied. The
copy is independent of the original.

## Ownership transfer

- The owner of a personal project can transfer it to an existing collaborator. Share the project first to transfer it to someone else.
- An organization owner or admin can transfer an organization project to another member. It becomes that member's personal project, and other members lose access.
- The person who transfers a project keeps edit access as a collaborator. The new owner can change or remove it.
- Other collaborators of a personal project keep their access. All share links are revoked, because only the previous owner knows their tokens.
- If the new owner already uses the project's name, it gets a numeric suffix.

## Share links

The owner of a personal project manages share links in the **Collaboration** panel. Anyone with a link can view without signing in, at `/share/<token>`. Organization projects have no share links in v1.

- **Sources and PDF** shows the file tree, read-only sources with live edits from the collaboration room, and the latest PDF.
- **PDF only** shows the latest PDF and the live build state. It cannot read sources, build logs, job status, or other generated files.
- Links never write: they cannot edit, save, compile, or change metadata.
- A project has at most 10 links. The full link is shown once, when it is created; only a SHA-256 hash of its token is stored. Copy it then, or create another.
- Creating a bare link without a recipient sends no email. Optionally entering a recipient email when creating a link emails that person the read-only link directly; the owner and existing collaborators are rejected so people who already have access are not emailed.
- **Revoke** deletes a link. Open collaboration sockets close immediately and live build streams stop within the access re-check interval. Links of a project in the trash do not work until it is restored.

Decisions on the open questions in NAT-390:

- Guests have no presence. Their cursors are not shown to collaborators, and they do not see collaborators’ cursors or names in the editor. A build’s `builtBy` name is still part of the build state.
- Links do not expire. Revoke a link when it is no longer needed.

Decisions on the open questions in NAT-443:

- Project collaborator and share-link emails send immediately through the existing `EMAIL` binding. Digests and per-user mute preferences are deferred until higher-volume activity notifications exist.
- Share links remain copyable bearer URLs by default (sending no email); an email is sent only when the owner specifies a recipient email while creating a link.
- Comment `@mention` emails are deferred until comment mentions themselves are designed and shipped.

Server-side, a link acts as the principal `share:<linkId>` wherever a user ID is checked. `lockProject` resolves it against `project_share_link`, rejects writes, and rejects PDF-only links unless the caller asks for build content. API requests carry the token in the `share` query parameter, which takes precedence over the session.

## Review comments

Anyone with access to a project can comment on a passage, including viewers.
Comments never change sources. Share-link guests cannot read or write comments.

- **Add comment** is in the editor toolbar and context menu. It comments on the selection, or on the cursor's line when nothing is selected. The draft opens in the **Comments** view.
- Commented ranges are highlighted, and the gutter shows a marker on each open thread's first line. Selecting a marker opens its thread. On a line with several threads, each click opens the next one.
- **Comments** in the right sidebar lists **Open** and **Resolved** threads by file and position. Selecting a thread scrolls its editor to the range.
- Anyone who can comment can reply, resolve, and reopen. Replying to a resolved thread reopens it.
- Authors edit and delete their own comments. Deleting a thread's last comment deletes the thread. A thread's author and project editors can delete the whole thread.
- Limits are 10,000 characters per comment, 200 comments per thread, and 2,000 threads per project.

A thread stores the start and end of its range as Yjs relative positions in the file's collaboration document. Ranges therefore follow everyone's edits, saves, and Git pulls, which merge into the document as diffs. Text typed at either edge stays outside the range. When the commented text is deleted, the thread remains and shows **text deleted**. A thread whose author was offline shows **position unavailable** until their edits synchronize. Threads on deleted files disappear. Deleting a user account deletes that user's comments.

Decisions on the open questions in NAT-386:

- Comments are stored in Postgres (`project_comment_thread` and `project_comment`), not in the collaboration Durable Object. The object rejects document updates from viewers, and viewers must still be able to comment. Postgres also keeps access checks in `lockProject` and cascades deletion with projects, files, and users. Open workspaces notice changes through `commentsVersion` in the existing two-second metadata poll, then reload the threads.
- Comments send no email notifications in v1.

## Release policy content

NAT-299 remains open in the v1 UI and content pass. The privacy and terms pages
now show general templates with prominent placeholder notices, unset effective
dates, and sections marked **To be completed**. Final policies still need
product-owner approval before release. The
[policy review draft](release/nat-299-policy-review.md) records source-backed copy,
the missing owner decisions, and the remaining release checks. Privacy and Terms
are already linked from the shared footer and sign-in page.

## Verification

`apps/app/test/compile-route.ts` covers share-link build access, PDF-only limits, rejected writes, and revocation. `apps/app/test/collaboration.ts` covers guest sockets: read-only sync, live edits, no presence, PDF-only rejection, and live revocation of sockets and build streams.

`apps/app/test/ui-overhaul.ts` exercises authenticated project creation, listing, opening, deletion, sharing errors, grants, role changes in both directions, live revocation, file management, and ZIP export. Keyboard checks cover navigation, file action dialogs, focus restoration, access removal, saving, and export. Public pages and the workspace are captured at desktop and mobile sizes. CI runs this suite against an isolated Postgres test database and local Worker services after the web build. `bun run --cwd apps/app test:ui` builds the app and runs the same checks locally when `INTEGRATION_DATABASE_URL` points to an isolated database with the current schema and `test` in its name.
