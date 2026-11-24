import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { editorLanguage } from "#/lib/editor/latex/language";
import { browserSpellChecker } from "#/lib/editor/spelling/checker";
import {
  personalDictionaryChanged,
  spellcheck,
} from "#/lib/editor/spelling/editor";

import { personalDictionaryHas } from "../../src/lib/settings/settings.schema";

export type SpellingTest = {
  text: () => string;
  words: () => string[];
};

declare global {
  interface Window {
    spellingTest: SpellingTest;
  }
}

const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Introduction}\label{sec:tyop}
This sentense has a mistake, see \ref{fig:wrnog} and \cite{knuth84}.
% A commment is ignored.
$\mathrm{qwzx}$ math and Texfolia are checked.
\end{document}`;

function App() {
  const view = useRef<EditorView | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const wordsRef = useRef(new Set<string>());
  window.spellingTest = {
    text: () => view.current?.state.doc.toString() ?? "",
    words: () => [...wordsRef.current],
  };
  const extensions = useMemo(
    () => [
      editorLanguage({
        filename: "main.tex",
        getProblems: () => [],
        publishSyntax: () => {},
      }),
      spellcheck({
        language: "en-US",
        checker: browserSpellChecker(),
        isKnown: (word) => personalDictionaryHas(wordsRef.current, word),
        addWord: (word) => {
          wordsRef.current = new Set([...wordsRef.current, word]);
          setWords([...wordsRef.current]);
          view.current?.dispatch({ effects: personalDictionaryChanged.of() });
        },
      }),
    ],
    [],
  );
  return (
    <>
      <output aria-label="Personal words">{words.join(",")}</output>
      <CodeMirror
        value={source}
        height="400px"
        extensions={extensions}
        onCreateEditor={(created) => {
          view.current = created;
        }}
      />
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
