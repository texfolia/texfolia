# @texfolia/codemirror-lang-latex

LaTeX, BibTeX, and BibTeX style language support for CodeMirror 6.

## Install

```sh
npm install @texfolia/codemirror-lang-latex @codemirror/language @codemirror/state @codemirror/view @codemirror/autocomplete @codemirror/lint @lezer/common @lezer/highlight @lezer/lr
```

## Usage

Attach `latex()` for LaTeX files, `bibtex()` for `.bib` files, `bst()` for `.bst` files, or resolve by filename with `languageForFilename()`.

```ts
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { languageForFilename, latex } from "@texfolia/codemirror-lang-latex";

const view = new EditorView({
  state: EditorState.create({
    doc: "\\documentclass{article}\n\\begin{document}\nHello $x^2$.\n\\end{document}\n",
    extensions: [latex({ enableAutocomplete: true, enableLinting: true })],
  }),
  parent: document.body,
});

const bibSupport = languageForFilename("references.bib");
```

To highlight code inside `minted` and `lstlisting` environments, pass a `codeLanguages` resolver to `latex()`.

```ts
import { javascript } from "@codemirror/lang-javascript";
import { latex } from "@texfolia/codemirror-lang-latex";

const support = latex({
  codeLanguages: (name) =>
    name === "js" || name === "javascript" ? javascript().language : null,
});
```

## Supported file extensions

| Extension                                              | Language                                     | Parser                           |
| ------------------------------------------------------ | -------------------------------------------- | -------------------------------- |
| `.tex`, `.ltx`                                         | LaTeX documents                              | Lezer LR (`latexLanguage`)       |
| `.sty`, `.cls`, `.bbx`, `.cbx`, `.lbx`, `.dtx`, `.ins` | LaTeX packages, classes, and BibLaTeX styles | Lezer LR (`latexLanguage`)       |
| `.bib`                                                 | BibTeX bibliography databases                | Lezer LR (`bibtexLanguage`)      |
| `.bst`                                                 | BibTeX style files                           | `StreamLanguage` (`bstLanguage`) |

## Exports

- `latex(config?)` returns a `LanguageSupport` for LaTeX. Options: `enableAutocomplete` (default `true`), `enableLinting` (default `false`), `linterOptions`, and `codeLanguages` for `parseMixed` nesting inside `minted` and `lstlisting`.
- `latexLanguage` is the Lezer `LRLanguage` for LaTeX, including external tokenizers and a `ContextTracker` for `\verb`, verbatim environments, math environments, and environment recovery.
- `latexHighlighting` is the `styleTags` prop source attached to the LaTeX Lezer parser.
- `bibtex()` and `bibtexLanguage` provide Lezer parsing, indentation, folding, and highlighting for `.bib` files.
- `bibtexHighlighting` is the `styleTags` prop source attached to the BibTeX Lezer parser.
- `bst()` and `bstLanguage` provide `StreamLanguage` highlighting for `.bst` files.
- `texLanguageDescriptions` is a `LanguageDescription[]` list covering all supported TeX, BibTeX, and BibTeX style extensions.
- `languageForFilename(filename, config?)` returns the matching `LanguageSupport` for a filename or `null`.
- `isLatexFilename(filename)` returns `true` for LaTeX-syntax extensions.
- `latexTags` exposes custom `@lezer/highlight` tags (`command`, `environment`, `math`, `argument`, `option`, `key`, `bibField`, `verbatim`) that inherit from standard tags.
- `latexCompletionSource` provides completions for LaTeX commands, package/class/BibLaTeX directives, and `\begin`/`\end` environments.
- `latexLinter(options?)` walks the Lezer syntax tree to report unmatched environments, braces, and math delimiters while skipping comments, escapes, `\verb`, and verbatim environments.
- `VERBATIM_ENVS` and `MATH_ENVS` expose the environment sets used by the LaTeX parser.

## License

MIT
