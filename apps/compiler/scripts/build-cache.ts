import { mkdir, writeFile } from "node:fs/promises";

import { compileSuccessfully } from "./engine-client";

// Alternate clean and restored-cache requests on one warm engine. Input preparation,
// TeX work, artifact serialization and transport all stay inside the timed region.
const bibliographyEnabled = process.env.WITH_BIBLIOGRAPHY === "1";
const fixture = String.raw`\documentclass{article}
\begin{document}
\tableofcontents
\section{Introduction}\label{sec:intro}
See Section~\ref{sec:end}. ${bibliographyEnabled ? "A citation~\\cite{knuth}." : ""}
${Array.from({ length: 25 }, (_, i) => `\\section{Section ${i}} This document exercises repeated references: Section~\\ref{sec:intro}.\\par`).join("\n")}
\section{Conclusion}\label{sec:end}
${bibliographyEnabled ? "\\bibliographystyle{plain}\\bibliography{references}" : ""}
\end{document}`;
const bibliography =
  "@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={Addison-Wesley}}";
let cache: Uint8Array | null = null;
const samples = [];
const directory = process.env.RESULT_DIR ?? "/tmp/texfolia-build-cache";
await mkdir(directory, { recursive: true });
for (let pair = -1; pair < Number(process.env.PAIRS ?? 5); pair++) {
  for (const mode of ["clean", "cached"] as const) {
    const started = performance.now();
    const output = await compileSuccessfully({
      files: { "main.tex": fixture, "references.bib": bibliography },
      clean: mode === "clean",
      cache: mode === "cached" ? cache : null,
    });
    const requestMs = performance.now() - started;
    for (const name of [
      "main.log",
      "main.aux",
      "main.toc",
      "main.synctex.gz",
      ...(bibliographyEnabled ? ["main.bbl"] : []),
    ])
      if (!output.files.has(name)) throw new Error(`Missing generated ${name}`);
    if (output.pdf.length < 1000) throw new Error("Invalid PDF output");
    const reruns = (output.result.log.match(/Rerunning TeX/g) ?? []).length;
    const bibtexPasses = (output.result.log.match(/Running BibTeX/g) ?? [])
      .length;
    if (bibliographyEnabled) {
      if (mode === "clean" && bibtexPasses === 0)
        throw new Error("Clean bibliography build skipped BibTeX");
      if (mode === "cached" && (bibtexPasses !== 0 || reruns !== 0))
        throw new Error(
          "Unchanged bibliography cache did not skip BibTeX and reruns",
        );
    }
    cache = output.cache;
    if (pair >= 0)
      samples.push({
        pair,
        mode,
        requestMs,
        compileMs: output.timing.compileMs,
        weightedCompileSeconds:
          output.timing.compileMs === null
            ? null
            : output.timing.compileMs / 1000,
        reruns,
        bibtexPasses,
        pdfBytes: output.pdf.length,
      });
    await writeFile(`${directory}/${mode}.pdf`, output.pdf);
    await writeFile(`${directory}/${mode}.log`, output.result.log);
  }
}
await writeFile(
  `${directory}/results.json`,
  JSON.stringify({ fixture, samples, errors: 0 }, null, 2),
);
console.info(JSON.stringify({ samples, errors: 0 }, null, 2));
