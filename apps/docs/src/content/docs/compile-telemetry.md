---
title: Compile telemetry
---

Compile events are structured log objects with `telemetryVersion: 1` and a
`jobId`. Join events by that ID. Each new compile action gets its own ID;
retries retain it. Compiler results also retain backend timing. The browser
reports preview timing to the authenticated compile route with PATCH after the
PDF renders or rendering fails. Reporting is best effort and does not block
compilation, so a successful backend job can have no preview event.

## Event boundaries

| Event                    | Boundary                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compile_web_submission` | Authenticated web POST through compiler acceptance or rejection. `submissionMs` includes web-side source reconciliation and the compiler request. |
| `compile_engine_request` | The app's whole compiler request for an attempt, with its engine timing.                                                                          |
| `compile_backend`        | Completed build attempt, including failures. `attempt` distinguishes retries.                                                                     |
| `compile_preview`        | Browser render result plus available backend timing. `outcome` is `rendered` or `preview_failed`.                                                 |

The compiler Worker knows no jobs or projects. It emits two events of its own with
`telemetryVersion: 2`. `compile_placement` records each compile's container, its
`outcome`, and `waitMs`. `affinity` and `spare` found a warm container, with and
without the caller's sources; `cold` waited for one. `compile_pool` reports pool
size (including containers that are `draining` their last compiles), leases, queue
depth, spare capacity, and the current window's hits and misses every minute while
containers exist.

## Timing fields

All durations are milliseconds unless the field says otherwise. Missing or null
fields mean unmeasured, not zero.

| Field                                     | Meaning                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queueWaitMs`                             | Time from job creation to the attempt starting. For project revisions this includes debounce and scheduling, even though the normal path uses no queue. |
| `inputReadMs`                             | Always zero for project revisions, because their engine client owns source loading. Kept for timeline compatibility.                                    |
| `engineRequestMs`                         | Compiler request, including the wait for a container, source transfer, cache restoration when needed, and the response.                                 |
| `inputPrepMs`, `compileMs`, `outputMs`    | Engine source preparation, TeX execution, and output processing. These are portions of engine work, not additional backend stages to sum.               |
| `publishMs`                               | Artifact and cache publication phase.                                                                                                                   |
| `backendMs`                               | Job creation through backend result preparation. Overlaps the stages above.                                                                             |
| `submissionMs`, `pollingMs`, `downloadMs` | Browser submission, waiting for the result, and fetching PDF data. The browser's `submissionMs` differs from the web POST duration of the same name.    |
| `previewMs`                               | PDF file readiness through the browser's render result.                                                                                                 |
| `actionToPdfMs`                           | Compile action through the first reported PDF render result.                                                                                            |
| `keystrokeToPdfMs`                        | Last source edit through that render result, or null if no edit was recorded. Includes time spent before requesting compilation.                        |
| `firstPdfByteMs`                          | Time to the first PDF byte at the reporting layer. Engine and browser values describe different boundaries.                                             |

`engine`, `plan`, `temperature`, `artifactReused`, and `cacheUsed` identify the
cohort. `temperature` counts TeX runs in a process; it does not prove that the
container was cold. `containerStartMs` is the wait for a container, including any
cold start or queue. `prewarmed` marks a warm container that had no sources of this
project. `archiveStatus` says whether the build cache was already in the container
(`warm`), came with the request (`restored`), or was `missing`, `invalid`, or
`unavailable`. `archiveFetchMs` is the app's storage read and `archiveUnpackMs` the
engine's unpacking.

## Persisted timelines

The workspace Logs tab reads a per-job timeline from `project_job.timing`
(jsonb). Each part is optional and merged independently:

| Key        | Written by                                   | Contents                                                                              |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `web`      | Web POST at reservation                      | `receivedAt`, the web route’s receipt instant.                                        |
| `compiler` | Web GET when it reconciles a terminal status | Compiler result timing plus `acceptedAt` (coordinator `createdAt`).                   |
| `client`   | Browser preview PATCH, first report only     | The `compile_preview` fields, including `requestSentMs`, `serverMs` and `notifiedMs`. |

Compiler timing adds compiler-clock instants: `startedAt` (attempt start),
`firstPdfAt` (first streamed PDF), `engineFinishedAt` and `publishedAt`, plus
`debounceMs` and `delivery` (`direct` or `overflow`). `requestSentMs` and
`notifiedMs` are browser durations from the compile action to the submission
request leaving the browser and to the terminal build event. `serverMs` is the web
route’s own POST duration, returned in the submission response. The browser
maps its durations onto server time as
`receivedAt + (t - requestSentMs - (submissionMs - requestSentMs - serverMs) / 2)`;
it never sends or uses its wall clock.

Only the `compileHistoryLimit` most recent jobs per project keep a timeline. Each
terminal reconciliation sets `timing` to null on older rows, which remain for
accounting. History and log reads (`?history=1`, `?job=<id>&log=1`) use the job
log ACL: PDF-only share links receive 404.

## Query preview percentiles

Export decoded event objects as newline-delimited JSON to `compile-events.jsonl`.
For a DuckDB session in that directory, this query groups successfully rendered
previews by engine, plan, and process temperature. Explicit column types retain
optional fields even when every value is missing or null. See DuckDB
[JSON loading](https://duckdb.org/docs/stable/data/json/loading_json) and
[aggregate functions](https://duckdb.org/docs/stable/sql/functions/aggregates).

```sql
SELECT
	engine,
	plan,
	temperature,
	count(*) AS samples,
	quantile_cont(actionToPdfMs, 0.50) AS action_to_pdf_p50_ms,
	quantile_cont(actionToPdfMs, 0.95) AS action_to_pdf_p95_ms,
	quantile_cont(keystrokeToPdfMs, 0.50) AS keystroke_to_pdf_p50_ms,
	quantile_cont(keystrokeToPdfMs, 0.95) AS keystroke_to_pdf_p95_ms
FROM read_json('compile-events.jsonl', format = 'newline_delimited', columns = {
	event: 'VARCHAR', outcome: 'VARCHAR',
	engine: 'VARCHAR', plan: 'VARCHAR', temperature: 'VARCHAR',
	actionToPdfMs: 'DOUBLE', keystrokeToPdfMs: 'DOUBLE'
})
WHERE event = 'compile_preview' AND outcome = 'rendered'
GROUP BY engine, plan, temperature;
```

Keep failures and missing preview reports visible in a separate event count.
Do not infer end-to-end latency from backend events alone or add overlapping
timings. Compare equivalent projects, plans, cache states, and runtime locations.
The query describes reporting, not a production latency claim.

The authoritative schemas for compiler and browser preview timing are in
[`packages/contracts`](../../../../../packages/contracts/src/telemetry.ts).
