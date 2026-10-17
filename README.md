# Texfolia

Blazingly fast LaTeX editor, built with [gpui](https://gpui.rs) and [Tectonic](https://tectonic-typesetting.github.io)

## Getting Started

```bash
git clone https://github.com/natebabyak/texfolia.git
cd texfolia
```

```bash
cargo run
```

The first build downloads a platform [Pdfium](https://github.com/bblanchon/pdfium-binaries) dynamic library into `target/debug/` (or `release/`) next to the binary. PDF preview loads that library at runtime (`pdfium-render`); for a macOS `.app`, place it in `Contents/Frameworks/` (or next to the executable). Override with `PDFIUM_LIB_PATH`, or skip the fetch with `PDFIUM_SKIP_DOWNLOAD=1`.

Compile with **⌘⏎** / **Ctrl+Enter**, or **⌘S** / **Ctrl+S** to save and compile. If Tectonic is missing, Texfolia offers to install it (Homebrew) or run it via Docker. Logs appear in the bottom Compilation panel.

## License

MIT
