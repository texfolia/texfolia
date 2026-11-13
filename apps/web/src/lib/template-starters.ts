export const starterLicense = `SPDX-License-Identifier: CC0-1.0

These original Texfolia starter source files are dedicated to the public domain
under CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/
To the extent possible under law, the author has waived all copyright and
related or neighboring rights to these starter source files.
No affiliation with a university, publisher, or journal is implied.
`;

export const templateStarters = [
  {
    slug: "article",
    title: "Simple article",
    description:
      "An original, minimal article starter with a title, abstract, and section headings. No journal-specific formatting or third-party template files.",
    tags: ["article", "common"],
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
\section{Methods}
Describe your approach.
\section{Results}
Present your findings.
\section{Conclusion}
Explain what your findings mean.
\end{document}
`,
  },
  {
    slug: "journal",
    title: "Two-column journal article",
    description:
      "An original two-column article starter for drafting a manuscript. Generic layout only: not an official journal template and not a claim of compliance with any publisher's submission rules.",
    tags: ["journal", "article", "two-column"],
    source: String.raw`\documentclass[10pt,twocolumn]{article}
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
  },
  {
    slug: "thesis",
    title: "Thesis starter",
    description:
      "An original report-class thesis scaffold with a title page, abstract, contents, and chapters. Not a university template: check your institution's formatting requirements before submission.",
    tags: ["thesis", "report"],
    source: String.raw`\documentclass[12pt]{report}
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
  },
];
