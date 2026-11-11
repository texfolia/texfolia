# Build cache measurements

Reference caching saves TeX work on the tested document. The bibliography
fixture shows no measurable improvement with Tectonic 0.15.0.

Measurements were taken on November 11, 2026, using the final Go engine in the
local compiler image. Docker limited the engine to one CPU and 1 GiB of memory.
Each fixture alternated five clean runs with five cached runs after one excluded
warm-up pair. Package and format caches were warm for both modes. No compile
failed. Sources were unchanged between runs.

| Fixture                          | Mode   | Median compile-seconds | Range         | Median engine request, ms | Range, ms   | TeX reruns |
| -------------------------------- | ------ | ---------------------: | ------------- | ------------------------: | ----------- | ---------: |
| References and table of contents | Clean  |                 0.3555 | 0.3529–0.3632 |                     358.6 | 354.8–364.7 |          2 |
| References and table of contents | Cached |                 0.2933 | 0.2912–0.2953 |                     295.6 | 293.8–297.7 |          0 |
| References, contents, and BibTeX | Clean  |                 0.5243 | 0.5153–0.5264 |                     526.3 | 517.2–528.2 |          6 |
| References, contents, and BibTeX | Cached |                 0.5214 | 0.5196–0.5296 |                     524.0 | 522.2–532.3 |          6 |

The reference fixture uses about 17.5% fewer weighted compile-seconds. Both modes
use the same Tectonic engine, so the weight is one. The engine request includes
input preparation, TeX, PDF conversion, multipart output, transport, and client
parsing. It excludes coordinator debounce, R2 persistence, browser polling, and
PDF rendering. These measurements do not establish a browser latency saving.

A separate profiling run sampled 99.29% CPU use in the container with one CPU.
The host load average before the experiment was about 1.8. The driver log shows
that restored auxiliaries remove the reference fixture's two reruns. TeX and
PDF conversion dominate these requests, rather than the request generator or
artifact transfer. The ranges of the reference runs do not overlap.

The bibliography fixture always invokes BibTeX and then reaches Tectonic's rerun
limit with warnings about `main.bbl` change detection. Its ranges overlap, so the
small difference between its medians is inconclusive. The
[Tectonic 0.15 driver](https://github.com/tectonic-typesetting/tectonic/blob/tectonic%400.15.0/src/driver.rs)
runs BibTeX whenever the auxiliary file contains `\bibdata`. Cache restoration
does not change that rule. Replacing that driver behavior belongs to a separate
engine change.

The benchmark checks the PDF and every expected generated file, including
SyncTeX. Extracted PDF text was identical between clean and cached reference
builds. The bibliography PDF contained its citation and bibliography entry,
with resolved section references. The separate output verification generated a
`.tex` file, restored it, compiled `\input{out/generated.tex}`, and produced the
expected text. It also checked that invalid TeX returns its full generated log.

The scripts are rerunnable from the repository root against an isolated engine:

```sh
RESULT_DIR=/private/tmp/nat225-refs ENGINE_URL=http://localhost:8081 bun apps/compiler/scripts/build-cache.ts
WITH_BIBLIOGRAPHY=1 RESULT_DIR=/private/tmp/nat225-bib ENGINE_URL=http://localhost:8081 bun apps/compiler/scripts/build-cache.ts
ENGINE_URL=http://localhost:8081 bun apps/compiler/scripts/verify-build-output.ts
```

Each benchmark directory contains `results.json`, both PDFs, and both logs.
