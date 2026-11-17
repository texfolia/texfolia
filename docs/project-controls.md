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
| Change access    | Sharing with the same email updates that person's role.                                                                                                                            |
| Revoke access    | **Remove** revokes a collaborator's access. The project disappears from their project list, and their open workspace loses access.                                                 |
| File management  | Editors can create files and folders, upload source files, and rename, move, or delete items. Deletion requires confirmation. Viewers have no source management controls.          |
| Access display   | The project list shows the actual collaborator count, **Personal** when there are none, or **Organization** for inherited membership. The workspace lists actual people and roles. |

Organization projects inherit access from membership. Every organization member is an editor on every organization project, whatever their role (`owner`, `admin`, or `member`). Members can save sources, compile, write to collaboration, and use write assistant tools. Organization projects have no viewer role and no per-project roles. Owners and admins additionally can delete organization projects and link or unlink a git remote. The workspace explains this and shows no personal-project sharing form. Organization creation, invitations, and membership administration have no management UI in v1. The invitation acceptance route remains available for existing invitations.

The public header links to Templates and Pricing. GitHub and GitLab integration is available from the right sidebar. Repositories can be imported from Projects. The Pro AI assistant is part of v1.

## Release policy content

NAT-299 remains open in the v1 UI and content pass. The privacy and terms pages
now show general templates with prominent placeholder notices, unset effective
dates, and sections marked **To be completed**. Final policies still need
product-owner approval before release. The
[policy review draft](release/nat-299-policy-review.md) records source-backed copy,
the missing owner decisions, and the remaining release checks. Privacy and Terms
are already linked from the shared footer and sign-in page.

## Verification

`apps/web/test/ui-overhaul.ts` exercises authenticated project creation, listing, opening, deletion, sharing errors, grants, role changes in both directions, live revocation, file management, and ZIP export. Keyboard checks cover navigation, file action dialogs, focus restoration, access removal, saving, and export. Public pages and the workspace are captured at desktop and mobile sizes. CI runs this suite against an isolated Postgres test database and local Worker services after the web build. `bun run --cwd apps/web test:ui` builds the app and runs the same checks locally when `INTEGRATION_DATABASE_URL` points to an isolated database with the current schema and `test` in its name.
