import assert from "node:assert/strict";

import { encodeBase64 } from "../src/artifacts";
import { createEngineClient } from "../src/engine";
import type { Engine } from "../src/jobs";
import type { Project } from "../src/project";

const engine = createEngineClient(
  (request) => fetch(request),
  process.env.ENGINE_URL ?? "http://127.0.0.1:8081",
);
type Cache = NonNullable<Parameters<Engine>[1]["cache"]>;
const bibliography = String.raw`@book{knuth, author={Donald Knuth}, title={Original Title}, year={1984}, publisher={Publisher}}
@book{lamport, author={Leslie Lamport}, title={Second Reference}, year={1994}, publisher={Publisher}}`;
const document = (
  citation = "knuth",
  heading = "Introduction",
  style = "plain",
) =>
  String.raw`\documentclass{article}
\begin{document}
\tableofcontents
\section{${heading}}\label{intro}
See Section~\ref{end}. A citation~\cite{${citation}}.
\section{Conclusion}\label{end}
\bibliographystyle{${style}}\bibliography{references}
\end{document}`;

for (const documentClass of ["article", "report", "book", "amsart", "beamer"]) {
  const body =
    documentClass === "beamer"
      ? String.raw`\begin{frame}Ready\end{frame}`
      : "Ready";
  const output = await engine(
    {
      mainFile: "main.tex",
      files: {
        "main.tex": String.raw`\documentclass{${documentClass}}\begin{document}${body}\end{document}`,
      },
    },
    { jobId: crypto.randomUUID(), attempt: 1, plan: "free" },
  );
  assert.ok(output.pdf.length > 1000, `${documentClass}: missing PDF`);
  assert.doesNotMatch(output.log, /generating format/i, documentClass);
  console.info(`${documentClass}: compiled using baked format`);
}

async function compile({
  label,
  files,
  cache,
  bibtex,
  text,
  mainFile = "main.tex",
}: {
  label: string;
  files: Project["files"];
  cache?: Cache;
  bibtex: boolean;
  text: string;
  mainFile?: string;
}) {
  const output = await engine(
    { mainFile, files },
    { jobId: crypto.randomUUID(), attempt: 1, plan: "free", cache },
  );
  assert.equal(/Running BibTeX/.test(output.log), bibtex, label);
  assert.doesNotMatch(
    output.log,
    /generating format|stopping at 6 passes/i,
    label,
  );
  if (!bibtex) assert.doesNotMatch(output.log, /bibtex was run/, label);
  const pdfText = Bun.spawn(["pdftotext", "-", "-"], {
    stdin: new Blob([output.pdf]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const extracted = await new Response(pdfText.stdout).text();
  assert.equal(
    await pdfText.exited,
    0,
    await new Response(pdfText.stderr).text(),
  );
  assert.ok(extracted.includes(text), `${label}: missing ${text} in PDF`);
  assert.ok(
    extracted.includes("See Section 2."),
    `${label}: unresolved reference`,
  );
  const next: Cache = {};
  for (const [path, blob] of Object.entries(output.files ?? {}))
    next[path] = {
      base64: encodeBase64(new Uint8Array(await blob.arrayBuffer())),
    };
  assert.ok(next["main.bbl"], `${label}: missing restored bibliography`);
  console.info(`${label}: verified PDF, BibTeX ${bibtex ? "ran" : "skipped"}`);
  return next;
}

const files = { "main.tex": document(), "references.bib": bibliography };
const clean = await compile({
  label: "clean",
  files,
  bibtex: true,
  text: "Original Title",
});
await compile({
  label: "unchanged",
  files,
  cache: clean,
  bibtex: false,
  text: "Original Title",
});
await compile({
  label: "prose edit",
  files: { ...files, "main.tex": document("knuth", "Revised Introduction") },
  cache: clean,
  bibtex: false,
  text: "Revised Introduction",
});
const edited = await compile({
  label: "bib edit",
  files: {
    ...files,
    "references.bib": bibliography.replace("Original Title", "Changed Title"),
  },
  cache: clean,
  bibtex: true,
  text: "Changed Title",
});
await compile({
  label: "bib edit cached",
  files: {
    ...files,
    "references.bib": bibliography.replace("Original Title", "Changed Title"),
  },
  cache: edited,
  bibtex: false,
  text: "Changed Title",
});
await compile({
  label: "citation edit",
  files: { ...files, "main.tex": document("lamport") },
  cache: clean,
  bibtex: true,
  text: "Second Reference",
});
await compile({
  label: "style edit",
  files: { ...files, "main.tex": document("knuth", "Introduction", "alpha") },
  cache: clean,
  bibtex: true,
  text: "Original Title",
});
await compile({
  label: "database edit",
  files: {
    "main.tex": document().replace("{references}", "{other}"),
    "other.bib": bibliography.replace("Original Title", "Other Database"),
  },
  cache: clean,
  bibtex: true,
  text: "Other Database",
});
const includedFiles = {
  ...files,
  "main.tex": document().replace(
    "A citation~\\cite{knuth}.",
    "\\include{chapter}",
  ),
  "chapter.tex": String.raw`A citation~\cite{knuth}.`,
};
const included = await compile({
  label: "included aux",
  files: includedFiles,
  bibtex: true,
  text: "Original Title",
});
await compile({
  label: "included aux cached",
  files: includedFiles,
  cache: included,
  bibtex: false,
  text: "Original Title",
});
await compile({
  label: "included citation edit",
  files: {
    ...includedFiles,
    "chapter.tex": String.raw`A citation~\cite{lamport}.`,
  },
  cache: included,
  bibtex: true,
  text: "Second Reference",
});
await compile({
  label: "changed bbl",
  files,
  cache: {
    ...clean,
    "main.bbl": {
      base64: encodeBase64(new TextEncoder().encode("Modified bibliography")),
    },
  },
  bibtex: true,
  text: "Original Title",
});
const missingBbl = { ...clean };
delete missingBbl["main.bbl"];
await compile({
  label: "missing bbl",
  files,
  cache: missingBbl,
  bibtex: true,
  text: "Original Title",
});
const missingMetadata = { ...clean };
delete missingMetadata[".texfolia-bibtex-v1"];
await compile({
  label: "legacy cache",
  files,
  cache: missingMetadata,
  bibtex: true,
  text: "Original Title",
});
await compile({
  label: "nested main",
  mainFile: "src/main.tex",
  files: { "src/main.tex": document(), "src/references.bib": bibliography },
  bibtex: true,
  text: "Original Title",
}).then((cache) =>
  compile({
    label: "nested cached",
    mainFile: "src/main.tex",
    files: { "src/main.tex": document(), "src/references.bib": bibliography },
    cache,
    bibtex: false,
    text: "Original Title",
  }),
);
