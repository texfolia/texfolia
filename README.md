# Texfolia

Blazingly fast LaTeX editor

## Workspace

Run the desktop app with `cargo run`. The `gpui-kit` workspace includes:

- A native title bar with a searchable command palette.
- A resizable project sidebar and a document-outline sidebar.
- A central dock with LaTeX source and PDF-preview panels. Drag tabs to rearrange
  the layout or use a panel's zoom control to expand it.
- A status bar with live source line/word counts and buffer state.

The initial `Untitled.tex` buffer is in memory; opening and saving project files
are not implemented yet. The PDF panel is an empty state, not a compiled preview.
The outline recognizes section declarations at the start of a source line,
including starred commands and optional short titles; it does not evaluate TeX.
Click an outline entry to navigate to that source line.

| Command                | macOS         | Windows / Linux |
| ---------------------- | ------------- | --------------- |
| Command palette        | `Cmd+Shift+P` | `Ctrl+Shift+P`  |
| Toggle project sidebar | `Cmd+B`       | `Ctrl+B`        |
| Toggle outline sidebar | `Cmd+Alt+B`   | `Ctrl+Alt+B`    |
| Focus source           | `Cmd+1`       | `Ctrl+1`        |
| Focus preview          | `Cmd+2`       | `Ctrl+2`        |

## Validation

```sh
cargo check
cargo test

```

## License

MIT
