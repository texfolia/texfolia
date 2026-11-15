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

Organization projects inherit access from membership. The workspace explains this and shows no personal-project sharing form. Organization creation, invitations, and membership administration have no management UI in v1. The invitation acceptance route remains available for existing invitations.

The public header links to Templates and Pricing. Git integration is canceled and has no launch claim or workspace control. The Pro AI assistant is part of v1.

## Verification

`apps/web/test/ui-overhaul.ts` exercises authenticated project creation, listing, opening, deletion, sharing errors, grants, role changes in both directions, live revocation, file management, and ZIP export. Keyboard checks cover navigation, file action dialogs, focus restoration, access removal, saving, and export. Public pages and the workspace are captured at desktop and mobile sizes. CI runs this suite against an isolated Postgres test database and local Worker services after the web build. `bun run --cwd apps/web test:ui` builds the app and runs the same checks locally when `INTEGRATION_DATABASE_URL` points to an isolated database with the current schema and `test` in its name.
