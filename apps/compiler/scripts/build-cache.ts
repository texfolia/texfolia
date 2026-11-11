import { mkdir, writeFile } from "node:fs/promises";

import { encodeBase64 } from "../src/artifacts";
import { createEngineClient } from "../src/engine";
import type { Engine } from "../src/jobs";

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
const engine = createEngineClient(
  (request) => fetch(request),
  process.env.ENGINE_URL ?? "http://127.0.0.1:8081",
);
let cache: Parameters<Engine>[1]["cache"];
const samples = [];
const directory = process.env.RESULT_DIR ?? "/private/tmp/nat225-cache";
await mkdir(directory, { recursive: true });
for (let pair = -1; pair < Number(process.env.PAIRS ?? 5); pair++) {
  for (const mode of ["clean", "cached"] as const) {
    const started = performance.now();
    const output = await engine(
      {
        mainFile: "main.tex",
        files: { "main.tex": fixture, "references.bib": bibliography },
      },
      {
        jobId: crypto.randomUUID(),
        attempt: 1,
        plan: "free",
        ...(mode === "cached" && cache ? { cache } : {}),
      },
    );
    const requestMs = performance.now() - started;
    for (const name of [
      "main.pdf",
      "main.log",
      "main.aux",
      "main.toc",
      "main.synctex.gz",
      ...(bibliographyEnabled ? ["main.bbl"] : []),
    ])
      if (!output.files?.[name]) throw new Error(`Missing generated ${name}`);
    if (output.pdf.length < 1000) throw new Error("Invalid PDF output");
    const reruns = (output.log.match(/Rerunning TeX/g) ?? []).length;
    cache = {};
    for (const [path, blob] of Object.entries(output.files ?? {}))
      cache[path] = {
        base64: encodeBase64(new Uint8Array(await blob.arrayBuffer())),
      };
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
        pdfBytes: output.pdf.length,
      });
    await writeFile(`${directory}/${mode}.pdf`, output.pdf);
    await writeFile(`${directory}/${mode}.log`, output.log);
  }
}
await writeFile(
  `${directory}/results.json`,
  JSON.stringify({ fixture, samples, errors: 0 }, null, 2),
);
console.info(JSON.stringify({ samples, errors: 0 }, null, 2));
