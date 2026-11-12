# Tectonic cache integration

The compiler image builds Tectonic 0.15.0 from its pinned upstream commit,
`0a8e2f52b895e2fd60cb461c1859b927a18e024d`, with `driver.patch` and
`bibtex_cache.rs`. Rust 1.79 builds the upstream lockfile without dependency
updates; newer Rust versions reject some of those upstream dependencies.
BuildKit keeps Cargo downloads and compilation outputs between image builds.

## Formats and bundles

Article, report, book, amsart, and beamer use the same Tectonic `latex` format,
not five class-specific formats. The Docker warm-up compiles each class to bake
that shared format and the classes' packages/fonts into the engine user's cache.
Both `HOME` and `XDG_CACHE_HOME` are fixed outside the disposable compile
directory. The Go engine forwards them to Tectonic, so the image cache and
newly downloaded bundle resources survive subsequent compiles in the project's
container. A clean build clears project outputs, not these engine resources.

## Bibliographies

Upstream 0.15.0 runs BibTeX whenever the fresh main aux contains `\bibdata`.
The patch makes this decision after TeX has emitted its actual aux data, without
an extra probe TeX process or source-level guesses about `\cite` expansion.

The fingerprint includes:

- The main aux and recursively referenced `\@input` auxiliaries, considering
  `\citation`, `\bibdata`, and `\bibstyle` records rather than reference labels.
- The contents of each referenced `.bib` and `.bst`, read through Tectonic's
  existing I/O stack so source, generated, and bundled files resolve normally.
- Every required, nonempty `.bbl` and its contents.

A successful build writes the SHA-256 fingerprint to `out/.texfolia-bibtex-v1`.
It travels with the existing complete build-output cache; no process-local state
or extra storage protocol is needed. A clean build, legacy cache, missing bbl,
missing dependency, or unsupported aux syntax takes the normal BibTeX path.
Changing bibliography data, citation commands (including macro-expanded cites),
or styles invalidates the fingerprint. Prose and reference changes do not.

Normal TeX reference/contents rerun detection remains enabled, and citation inputs
are checked again after those reruns. After BibTeX writes a bbl, the patch resets
its access pattern to written: that producer output is consumed by subsequent
TeX passes, not a TeX read-then-rewrite dependency. This fixes upstream's stale
read-digest bookkeeping that otherwise keeps requesting bbl reruns until the
six-pass limit.

## Verification

The image build runs the fingerprint unit tests. To exercise the actual engine
and inspect generated PDF text, install Bun and Poppler (`pdftotext`), then run
from the repository root:

```sh
docker build --platform linux/amd64 -f apps/compiler/Dockerfile -t texfolia-latex-engine:nat238 .
docker run --rm --name texfolia-nat238 --cpus=1 --memory=1g -p 127.0.0.1:8081:8080 texfolia-latex-engine:nat238
ENGINE_URL=http://127.0.0.1:8081 bun apps/compiler/scripts/verify-bibliography-cache.ts
WITH_BIBLIOGRAPHY=1 ENGINE_URL=http://127.0.0.1:8081 RESULT_DIR=/private/tmp/nat238-bib bun apps/compiler/scripts/build-cache.ts
ENGINE_URL=http://127.0.0.1:8081 bun apps/compiler/scripts/verify-build-output.ts
```

The bibliography check verifies clean, cached, prose-edited, bibliography-edited,
citation-edited, style-edited, database-edited, included-aux, incomplete-cache,
changed-bbl, and nested-main builds. It checks the PDF text, resolved section
references, and whether BibTeX actually ran. The benchmark rejects cached
bibliography runs that invoke BibTeX or rerun TeX.
