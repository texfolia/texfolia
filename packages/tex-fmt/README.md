# @texfolia/tex-fmt

Clean-room WebAssembly build and TypeScript wrapper around upstream MIT [tex-fmt](https://github.com/WGUNDERWOOD/tex-fmt).

## Installation

```sh
npm install @texfolia/tex-fmt
```

## Usage

```ts
import { formatLatex } from "@texfolia/tex-fmt";

const { output, logs } = await formatLatex(
  "\\begin{itemize}\n\\item Hello\n\\end{itemize}\n",
  {
    tabsize: 2,
    wrap: true,
    wraplen: 80,
    usetabs: false,
  },
);
```

### Custom WASM URL or Module

By default, `@texfolia/tex-fmt` resolves its bundled `tex_fmt_bg.wasm` relative to the module URL (which Vite and modern bundlers emit as a hashed static asset automatically, and Node/Bun load from disk). To host the WASM binary elsewhere or pass a precompiled module:

```ts
import { createTexFmt } from "@texfolia/tex-fmt";

const formatter = createTexFmt({ wasmUrl: "/assets/tex_fmt_bg.wasm" });
const { output } = await formatter.format(source, { tabsize: 2 });
```

## Rebuilding the WASM binary

```sh
bun run --cwd packages/tex-fmt build:wasm
```

Requires Docker. Compiles upstream MIT `WGUNDERWOOD/tex-fmt` v0.5.7 for `wasm32-unknown-unknown` with `--features wasm`.

## License

MIT
