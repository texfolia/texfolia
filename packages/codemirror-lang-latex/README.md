# @texfolia/codemirror-lang-latex

Clean-room Lezer grammar and CodeMirror 6 language support for LaTeX and BibTeX.

## Installation

```sh
npm install @texfolia/codemirror-lang-latex @codemirror/language @codemirror/state @codemirror/view @codemirror/autocomplete @codemirror/lint @lezer/common @lezer/highlight @lezer/lr
```

## Usage

```ts
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bibtexLanguage, latex } from "@texfolia/codemirror-lang-latex";

const view = new EditorView({
  state: EditorState.create({
    doc: "\\documentclass{article}\n\\begin{document}\nHello $x^2$.\n\\end{document}\n",
    extensions: [latex({ enableAutocomplete: true, enableLinting: true })],
  }),
  parent: document.body,
});
```

## Exports

- `latex(config?)` — Returns a `LanguageSupport` instance for LaTeX with optional built-in autocompletion (`enableAutocomplete`, default `true`) and syntax linting (`enableLinting`, default `false`).
- `latexLanguage` — The underlying Lezer `LRLanguage` configured with syntax highlighting tags, indentation, and folding.
- `latexTags` — Custom `@lezer/highlight` tags (`command`, `environment`, `math`, `argument`, `option`, `key`, `bibField`) inheriting from standard tags so any CodeMirror theme works out of the box.
- `latexCompletionSource` — Built-in `CompletionSource` for standard LaTeX commands and `\begin{...}` / `\end{...}` environment snippets.
- `latexLinter(options?)` — Syntax linter checking balanced environments, braces, and math delimiters while ignoring comments and verbatim blocks.
- `bibtexLanguage` — `StreamLanguage` for `.bib` files.

## License

MIT
