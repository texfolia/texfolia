# db

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

To type check:

```bash
bun check
```

Run `bun run format` to format the code with Oxfmt.

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Existing object sizes

For an existing database created with `drizzle-kit push`, run
`bunx drizzle-kit migrate` from this directory to add the size columns. Then run
`bun run backfill:object-sizes --finalize` with `DATABASE_URL`, `S3_ENDPOINT`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `R2_PDF_BUCKET` set. Set
`R2_FILE_BUCKET` if project files use a separate bucket. The script checks
existing keys with R2 HEAD, can be rerun, and leaves the columns nullable if
any referenced object cannot be measured. On a fresh database, `bun run push`
creates the final schema directly.

The backfill also checks unfinished compile jobs older than five minutes for a
PDF under their reserved job ID. Run it without `--finalize` to reconcile these
jobs after a compiler transport failure.
