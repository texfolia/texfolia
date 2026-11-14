# Project path policy

The web app defines source validation in
[`source-path.schema.ts`](../apps/web/src/lib/source-path.schema.ts). The compiler
API defines its source and artifact schemas in
[`project.ts`](../apps/compiler/src/project.ts), and the Go engine implements the
same policy. All three implementations run against the cases in
[`path-policy.json`](../apps/compiler/test/fixtures/path-policy.json).

A source path is relative to the project root. The root node's display name is
not part of the path. Names and paths preserve spaces, Unicode, and Unicode
normalization exactly as supplied.

The policy has these limits:

- A full path contains 1–240 UTF-8 bytes, including folder names and slashes.
  A single component therefore also has a maximum of 240 bytes.
- Colons, backslashes, and U+0000–U+001F control characters are invalid.
- Components cannot be empty, `.` or `..`. A node name cannot contain a slash.
- The first component cannot be `out`, ignoring case. Nested names such as
  `chapters/out/notes.tex` are valid.
- Artifact paths use the same syntax, allow root `out`, and permit 255 UTF-8
  bytes. This leaves room for generated suffixes such as `.synctex.gz` when
  the main source filename reaches 240 bytes.

The source byte limit keeps accepted components below the engine filesystem's 255-byte
limit. Accented letters and emoji can use multiple bytes. The `.tex` extension
counts toward the limit. Source paths have no automatic trimming or renaming.

Creation validates the assembled path under the project lock before writing
source objects or node metadata. Template publishing validates every path before
copying source objects, and opening a template validates its snapshot before
creating the destination project. Compilation validates all active nodes,
including unreferenced files and empty folders.

## Repair existing invalid paths

1. Open the project. The **Repair source paths** form in the Files sidebar lists
   invalid paths and the reason each path fails.
2. To keep a backup, open **Export project** and click **Download zip**.
3. In **Repair source paths**, choose an affected file or parent folder, enter
   a valid name, and click **Rename**. For deeply nested paths, choose a folder
   closer to the root in **In folder**. Repeat until the form disappears.
4. Update LaTeX references to the renamed paths, then compile again.

Renaming requires project write access and preserves node IDs, source object
keys, file contents, and collaboration documents. Folder renames check descendant
lengths. Legacy paths that already exceed the limit can be shortened in several
steps, and unrelated invalid names can be repaired separately. No migration
silently changes names or LaTeX references.

Published template snapshots are immutable. An invalid legacy snapshot cannot be
opened as a project. Its source ZIP remains downloadable so the publisher can
repair the original project and publish a new snapshot.

## Run the policy checks

From the repository root, run:

```sh
bun test apps/web/src/lib/source-path.schema.test.ts apps/compiler/test/project.test.ts apps/web/src/lib/project-node.schema.test.ts apps/web/src/lib/project-paths.test.ts
(cd apps/compiler/engine && go test -race ./...)
```

The Go checks also write each accepted fixture path to the filesystem. The web
source-storage and template integration suites cover validation before R2 writes,
legacy-path repair, content preservation, and rejection of invalid snapshots.

To check boundary paths and generated SyncTeX files with a real local engine, run:

```sh
ENGINE_URL=http://127.0.0.1:8080 bun run apps/compiler/test/path-policy.integration.ts
```
