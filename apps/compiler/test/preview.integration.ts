import assert from "node:assert/strict";

import { compileSuccessfully } from "../scripts/engine-client";

const documents = [
  {
    title: "Simple article",
    source: String.raw`\documentclass[11pt]{article}
\title{Your next paper}
\author{Your name}
\date{\today}
\begin{document}
\maketitle
\begin{abstract}
Summarize your question, approach, and findings here.
\end{abstract}
\section{Introduction}
Introduce the problem and why it matters.
\end{document}
`,
  },
];

assert(
  process.env.ENGINE_URL,
  "Set ENGINE_URL to a local compile container with pdftoppm installed",
);
for (const document of documents) {
  const { preview, pdf } = await compileSuccessfully({
    files: { "main.tex": document.source },
    preview: true,
  });
  assert(preview);
  assert.deepEqual(
    preview.slice(0, 8),
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const dimensions = new DataView(preview.buffer, preview.byteOffset);
  assert.equal(
    Math.max(dimensions.getUint32(16), dimensions.getUint32(20)),
    1200,
  );
  console.log(
    `${document.title}: real container compile → ${pdf.length}-byte PDF + ${preview.length}-byte first-page PNG`,
  );
}
