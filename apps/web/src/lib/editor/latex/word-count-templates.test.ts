import { expect, test } from "bun:test";

import { countWords, wordEvents } from "@texfolia/editor";

const documents = {
  article: String.raw`\documentclass[11pt]{article}
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
\section{Methods}
Describe your approach.
\section{Results}
Present your findings.
\section{Conclusion}
Explain what your findings mean.
\end{document}
`,
  journal: String.raw`\documentclass[10pt,twocolumn]{article}
\title{Manuscript title}
\author{First Author \and Second Author}
\date{}
\begin{document}
\maketitle
\begin{abstract}
A concise summary of the manuscript.
\end{abstract}
\section{Introduction}
State the research question and context.
\section{Methods}
Describe the study design.
\section{Results}
Report the results.
\section{Discussion}
Discuss implications and limitations.
\end{document}
`,
  thesis: String.raw`\documentclass[12pt]{report}
\title{Thesis title}
\author{Your name}
\date{\today}
\begin{document}
\maketitle
\begin{abstract}
Summarize the thesis here.
\end{abstract}
\tableofcontents
\chapter{Introduction}
Introduce your research question.
\chapter{Background}
Review the relevant work.
\chapter{Methods}
Describe your methods.
\chapter{Results}
Present your results.
\chapter{Conclusion}
Discuss contributions and future work.
\end{document}
`,
} as const;

test("sample documents match texcount totals", () => {
  // Values from `texcount` 3.1.1 (text+headers+captions) on each document.
  const expected: Record<keyof typeof documents, [number, number, number]> = {
    article: [25, 8, 0],
    journal: [23, 7, 0],
    thesis: [23, 8, 0],
  };
  for (const [name, source] of Object.entries(documents) as [
    keyof typeof documents,
    string,
  ][]) {
    const words = countWords(
      new Map([["main.tex", wordEvents(source)]]),
      "main.tex",
    );
    expect([words.text, words.headers, words.captions]).toEqual(expected[name]);
  }
});
