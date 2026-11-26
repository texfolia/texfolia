# @texfolia/editor

Framework-agnostic LaTeX editor extensions and tooling for CodeMirror 6: language integration, project diagnostics, completions, formatting commands, outline extraction, TeXcount-style word counting, BibTeX helpers, and symbol insertion.

Built against `@codemirror/*` peer dependencies so it works with vanilla CodeMirror 6, `@uiw/react-codemirror`, or any other framework wrapper.

## Installation

```sh
npm install @texfolia/editor @codemirror/autocomplete @codemirror/language @codemirror/lint @codemirror/state @codemirror/view @lezer/highlight
```

## Usage

```ts
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  editorLanguage,
  emptyAnalysis,
  latexCompletion,
  toggleLatexCommand,
} from "@texfolia/editor";

const view = new EditorView({
  state: EditorState.create({
    doc: "\\documentclass{article}\n\\begin{document}\nHello world\n\\end{document}\n",
    extensions: [
      editorLanguage({
        filename: "main.tex",
        completion: latexCompletion(() => emptyAnalysis, ["main.tex"]),
        getProblems: () => [],
        publishSyntax: () => {},
      }),
    ],
  }),
  parent: document.body,
});

// Run a CodeMirror StateCommand directly:
toggleLatexCommand("textbf")(view);
```

## Exports

- **Language & lint**: `editorLanguage`, `projectDiagnostics`, `projectProblemsChanged`
- **Completions**: `latexCompletion`
- **Commands**: `toggleLatexCommand`, `applyLatexHeading`, `headingCommands`
- **Symbols & preamble**: `latexSymbols`, `searchLatexSymbols`, `latexPreamble`, `packageInsertion`, `addLatexPackage`, `insertLatexSymbol`
- **Project analysis**: `scanFile`, `analyzeProject`, `maskLatexSource`, `isIncludePath`, `emptyAnalysis`, `LatexAnalyzer`
- **Outline**: `projectOutline`
- **Word count**: `wordEvents`, `countWords`, `emptyWordCount`
- **BibTeX**: `parseReferenceId`, `bibEntryKeys`, `setEntryKey`, `uniqueEntryKey`, `entryAppendix`, `validEntryKey`, `similarKeys`, `newBibFile`
- **Format diffs**: `formatChanges`, `defaultFormatSettings`

## License

MIT
