import assert from "node:assert/strict";

import { compileSuccessfully, packCache, type Files } from "./engine-client";

type Cache = Map<string, Uint8Array>;
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

// Everything the image is warmed with compiles without a download.
const warmup = `${import.meta.dir}/../warmup`;
const references = await Bun.file(`${warmup}/references.bib`).text();
for (const name of [...new Bun.Glob("*.tex").scanSync(warmup)].sort()) {
  const output = await compileSuccessfully({
    affinity: name,
    files: {
      "main.tex": await Bun.file(`${warmup}/${name}`).text(),
      "references.bib": references,
    },
  });
  assert.ok(output.pdf.length > 1000, `${name}: missing PDF`);
  assert.doesNotMatch(
    output.result.log,
    /generating format|downloading/i,
    name,
  );
  console.info(`${name}: compiled from the image alone`);
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
  files: Files;
  cache?: Cache;
  bibtex: boolean;
  text: string;
  mainFile?: string;
}) {
  const output = await compileSuccessfully({
    mainFile,
    files,
    cache: cache ? await packCache(cache) : null,
  });
  assert.equal(/Running BibTeX/.test(output.result.log), bibtex, label);
  assert.doesNotMatch(
    output.result.log,
    /generating format|stopping at 6 passes/i,
    label,
  );
  if (!bibtex) assert.doesNotMatch(output.result.log, /bibtex was run/, label);
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
  const next: Cache = output.files;
  assert.ok(next.has("main.bbl"), `${label}: missing restored bibliography`);
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
  cache: new Map([
    ...clean,
    ["main.bbl", new TextEncoder().encode("Modified bibliography")],
  ]),
  bibtex: true,
  text: "Original Title",
});
const missingBbl = new Map(clean);
missingBbl.delete("main.bbl");
await compile({
  label: "missing bbl",
  files,
  cache: missingBbl,
  bibtex: true,
  text: "Original Title",
});
const missingMetadata = new Map(clean);
missingMetadata.delete(".texfolia-bibtex-v1");
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
