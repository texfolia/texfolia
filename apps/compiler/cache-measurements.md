# Build cache measurements

The November 11 baseline showed reference-cache savings but no measurable
bibliography improvement with upstream Tectonic 0.15.0. The November 12
NAT-238 results below include the citation-aware driver change.

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
does not change that rule. NAT-238 replaces that driver behavior, as measured
below.

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

## NAT-238: citation-aware driver, November 12, 2026

**Cached bibliography builds use 19.6% fewer compile-seconds than clean builds
with the same patched engine.** BibTeX passes fall from one to zero, and TeX
reruns from two to zero. Clean builds also no longer hit the old six-rerun limit.

These measurements use the release-built, patched Tectonic 0.15.0 image, limited
to one CPU and 1 GiB, on an Apple Silicon host running the linux/amd64 image.
Each fixture alternates five clean and five cached requests after one excluded
warm-up pair, with identical sources and warm format/bundle resources. All
requests succeeded. Extracted PDF text is identical between clean and cached
outputs for both fixtures, including resolved citations and section references.

| Fixture                          | Mode   | Median compile-seconds | Range         | Median engine request, ms | Range, ms   | TeX reruns | BibTeX passes |
| -------------------------------- | ------ | ---------------------: | ------------- | ------------------------: | ----------- | ---------: | ------------: |
| References and table of contents | Clean  |                 0.3102 | 0.3055–0.3138 |                     312.0 | 307.4–315.7 |          2 |             0 |
| References and table of contents | Cached |                 0.2597 | 0.2563–0.2645 |                     262.3 | 259.1–267.0 |          0 |             0 |
| References, contents, and BibTeX | Clean  |                 0.3309 | 0.3239–0.3343 |                     333.0 | 325.8–336.5 |          2 |             1 |
| References, contents, and BibTeX | Cached |                 0.2660 | 0.2599–0.2770 |                     269.1 | 263.2–280.9 |          0 |             0 |

The clean/cached ranges do not overlap for either fixture. The reference fixture
uses 16.3% fewer compile-seconds. This compares the patched engine with itself,
not with the November 11 binary: the image now builds Tectonic from source and
uses system HarfBuzz. It does not establish a browser latency improvement.

A separate, excluded profiling run sampled 97.63% container CPU utilization
(218.2 MiB memory), supporting TeX/PDF work as the limiter on the one-CPU
container. Host load averages before the reported run were 1.34, 3.11, and 3.09
on ten logical CPUs. The request generator stayed outside the container; engine
compile timings and client request timings both improve. The eliminated work is
visible in the driver logs, rather than inferred from elapsed time alone.

Verification also covered:

- All five common classes compiled using only the image's cached resources
  (`--only-cached`), without generating a format. They share one `latex` format.
- Unchanged and prose-edited projects skip BibTeX while keeping normal contents
  and reference reruns enabled. Nested mains and included aux files reuse cache.
- Changes to `.bib` contents, citation keys (including inside an included file),
  bibliography database names, and bibliography styles update the PDF correctly.
- Missing bbl files, changed bbl contents, and legacy caches without fingerprint
  metadata run BibTeX. Clean builds always run it.
- Four native fingerprint tests, the compiler's 26 Bun tests, Go race tests,
  typecheck, Go vet, generated-output restoration, SyncTeX, and full failure logs
  passed.

The strengthened benchmark rejects cached runs that invoke BibTeX or rerun TeX.
Against the original image it fails with `Unchanged bibliography cache did not
skip BibTeX and reruns`; against the patched image it passes. The separate PDF
check also reproduces the original six-rerun-limit failure before the patch.

```sh
ENGINE_URL=http://127.0.0.1:8081 bun apps/compiler/scripts/verify-bibliography-cache.ts
WITH_BIBLIOGRAPHY=1 RESULT_DIR=/private/tmp/nat238-bib ENGINE_URL=http://127.0.0.1:8081 bun apps/compiler/scripts/build-cache.ts
RESULT_DIR=/private/tmp/nat238-refs ENGINE_URL=http://127.0.0.1:8081 bun apps/compiler/scripts/build-cache.ts
ENGINE_URL=http://127.0.0.1:8081 bun apps/compiler/scripts/verify-build-output.ts
```

Local run artifacts are in `/private/tmp/nat238-bib` and
`/private/tmp/nat238-refs`; excluded profiling samples are in
`/private/tmp/nat238-profile`. See [the integration notes](tectonic/README.md)
for the pinned driver patch, cache fingerprint, and image build commands.
