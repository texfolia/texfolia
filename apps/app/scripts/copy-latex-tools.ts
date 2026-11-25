// Copies wasm-latex-tools' assets into public/core, where the format worker
// loads them. Run before dev and build.
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { $ } from "bun";

import { latexToolsPath } from "#/lib/editor/latex/tools";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(`${root}public/core`, { recursive: true, force: true });
await $`wasm-latex-tools copy-assets ./public/${latexToolsPath}`.cwd(root);
