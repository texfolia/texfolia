# Templates

The template catalog and its snapshots: listing, publishing, previews, review,
cleanup, and creating a project from a template. A published snapshot is a
catalog entry, so catalog and publishing share one feature.

| Entry point              | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/lib/templates`        | Client-safe contracts: request schemas (`publishTemplateSchema`, `openTemplateSchema`, …), `templateLicenses` with labels and URLs, `templateSnapshotSchema`, and preview readiness subscriptions (`queuedTemplatePreviews`, `subscribeTemplatePreviews`)                                                                                                                                                                                                                                                                                                                              |
| `#/lib/templates/server` | Catalog: `listTemplates`, `listMyTemplates`, `findTemplate`, `getTemplate`, `templateArchive`, `templateDestinations`, `isTemplateReviewer`. Snapshots: `publishTemplate` and `openTemplate` (creates a project from a template). Previews: `refreshTemplatePreview` (one template, with the owner-or-reviewer retry check), `refreshTemplatePreviews` (the queue), `streamTemplatePreview` (SSE readiness stream), `templatePreview` (the image or its thumbnail, with caching). Review: `reportTemplate`, `reviewTemplate`, `templateReviewQueue`. Cleanup: `collectTemplateObjects` |

The rest of the app imports the core only through these entry points. The
modules that bind it to the app, named below, are imported by path.

See [Template lifecycle](../../../../docs/src/content/docs/templates.md) for storage, moderation,
preview, and retention rules.

## Boundaries

The feature depends on `@texfolia/db` (template rows), `#/lib/storage` (R2
objects and ZIPs), `#/lib/projects` (source paths and the `LockProject`
type), `#/lib/compile` (source hashes and the compiler client for previews),
`#/lib/auth` (organization roles), and `@texfolia/contracts`.

The core takes the rest as arguments:

- `lock`: `publishTemplate` takes a project lock built with `projectLock(grants)`,
  so the app decides which project access grants apply. After the lock,
  publishing itself requires the project owner or an organization admin.
- `bucket`: the `SOURCES` R2 binding.
- `images`: the `IMAGES` binding, which makes gallery thumbnails.
- `reviewers`: the comma-separated `TEMPLATE_REVIEWER_IDS` variable.

`template.functions.ts` has the server functions and session checks, and
`template-preview.ts` the React binding for preview readiness SSE updates. The `/template`, `/templates`, and
`/api/templates` routes, scheduled handlers, and the create-from-template UI stay
outside the feature. The public gallery stays in `apps/web`, which reads
`GET /api/templates`. Curated starters and their seed CLI stay in `@texfolia/db`.

## Checks

```sh
bun test apps/app/src/lib/templates
```

Database and R2 behavior is covered by `apps/app/test/templates.ts`, which needs
`INTEGRATION_DATABASE_URL`.
