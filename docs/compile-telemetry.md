# Compile telemetry

Compile events use `telemetryVersion: 1` and a stable `jobId`. The browser sends
`X-Compilation-Id` to the web app. The compiler stores that ID in its source
record, sends it through the queue, and forwards it to the Go engine. Status,
PDF download, and preview reports refer to the same ID.

The compiler retains backend timings in each terminal job result. The web app
forwards those timings in the status response. Existing jobs without timing
metadata remain readable.

## Events

| Event                    | Producer          | Meaning                                                                                                                                                        |
| ------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compile_web_submission` | Web app           | Submission through authentication, source validation, database reservation, and compiler acknowledgement. A rejected compiler request has `outcome: rejected`. |
| `compile_submission`     | Compiler API      | Source persistence and queue dispatch during the submission request.                                                                                           |
| `compile_engine`         | Go engine         | Engine stages for an accepted engine request, including failures.                                                                                              |
| `compile_engine_request` | Compiler consumer | Engine HTTP round trip, including startup, multipart transfer, and result decoding.                                                                            |
| `compile_retry`          | Compiler consumer | An infrastructure failure that needs another delivery.                                                                                                         |
| `compile_backend`        | Compiler consumer | A committed terminal result, with backend durations and success or failure status.                                                                             |
| `compile_preview`        | Web app           | A browser report after PDF.js renders its first page canvas, or encounters a preview error. Includes backend timing context when available.                    |

Backend events exist independently of browser reports. Preview reporting is a
best-effort request, authorized against the project and successful job. It does
not change the compile result. Re-rendering, zooming, and manually opened PDFs
do not generate additional reports for the same compiled File.

## Duration fields

All durations use milliseconds. In-process durations use monotonic clocks.
Queue wait and backend job age use server wall time across requests. Negative
wall-time differences are clamped to zero.

| Field              | Boundary                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submissionMs`     | For browser reports, **Save & compile** through receipt of the accepted job, including local source saving. For submission events, the producer's request handling as described above. |
| `queueWaitMs`      | Source record creation through the first consumer delivery. Preserved across retries. Legacy running jobs can have `null`.                                                             |
| `inputReadMs`      | Consumer source read and validation for the current attempt.                                                                                                                           |
| `inputPrepMs`      | Engine temporary directory, source files, and command preparation.                                                                                                                     |
| `compileMs`        | Tectonic process execution.                                                                                                                                                            |
| `outputMs`         | Engine transcript collection, PDF open, and size validation.                                                                                                                           |
| `engineRequestMs`  | Consumer's complete engine request. Includes the engine stages, container startup, and response transfer.                                                                              |
| `publishMs`        | Transcript and PDF writes for the current attempt.                                                                                                                                     |
| `backendMs`        | Source record creation through terminal result construction. Includes previous attempts and backoff. Excludes the terminal record write and cleanup.                                   |
| `pollingMs`        | Browser acknowledgement through observation of success. Includes the existing 1.5-second poll interval and transient request retries.                                                  |
| `downloadMs`       | Browser PDF fetch and body read.                                                                                                                                                       |
| `previewMs`        | Browser File availability through the first page render callback or preview error. Includes viewer loading and PDF parsing.                                                            |
| `actionToPdfMs`    | **Save & compile** through the preview outcome.                                                                                                                                        |
| `keystrokeToPdfMs` | Last source edit captured in the compile snapshot through the preview outcome. `null` if the session has no source edit.                                                               |

Engine stages that were not reached are `null`. Current-attempt operations that
did not run have zero duration. When a retry recovers an already published PDF,
`artifactReused` is true and the PDF metadata preserves its original engine
stages. The current attempt's engine request duration is zero.

These fields overlap and cannot all be added. `engineRequestMs` contains the
engine stages, while `pollingMs` contains backend work that follows acceptance.
`keystrokeToPdfMs` includes time the user waits before manually compiling.
`actionToPdfMs` separates that wait from the compile and preview path.

## Cohorts

`plan` is `pro` for the project owner's personal subscription with status
`active` or `trialing`, and `free` otherwise. A failed subscription lookup uses
`unknown`. Projects currently belong to users; switching the active organization
does not change this cohort. This label does not grant billing entitlements.

`engine` is `tectonic` today. The schema also accepts `texlive` for a future
engine integration and `unknown` for older or unreachable engines.

`temperature` is `cold` for the Go process's first compile and `warm` for later
compiles in that process. Health checks do not mark a process warm. This describes
process reuse. It does not claim the Tectonic package cache was empty or that a
container image was downloaded. Container startup is included in
`engineRequestMs`; the first compile still has a cold process label.

`attempt` identifies the consumer delivery. `artifactReused` identifies recovery
without another engine execution. Neither changes queue or retry behavior.

## Percentile query

Both Workers enable logs at sampling rate 1. Traces use sampling rate 0.01.
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
indexes the structured event fields. `event = compile_preview` and
`outcome = rendered` select completed preview samples in the web Worker's logs.

The repository query accepts JSON Lines containing event objects or Wrangler
JSON tail envelopes. This example captures the web Worker stream after deployment
and prints percentiles when the tail ends:

```sh
cd apps/web
bunx wrangler tail --format json | jq -c . > /tmp/compile-events.jsonl
```

From the repository root, the query command is:

```sh
bun run apps/compiler/scripts/compile-percentiles.ts < /tmp/compile-events.jsonl
```

The output groups by plan, temperature, and engine. Each metric includes its
sample count and nearest-rank p50 and p95. The query keeps the first rendered
report per job and excludes errors and jobs with no preview. Missing edit times
are excluded from keystroke percentiles while still contributing to action
percentiles. Invalid JSON lines are counted separately. Browser reports are
client measurements and can be lost on navigation, disconnection, or a closed
browser; the query describes observed renders, not all submitted jobs.

No source text, file paths, account IDs, or TeX transcripts are included in the
timing events.
