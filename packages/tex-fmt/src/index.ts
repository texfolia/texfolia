import initWasm, { type InitInput, main as wasmMain } from "./wasm/tex_fmt.js";

/**
 * Formatting options for `tex-fmt`.
 */
export type TexFmtOptions = {
  /** Number of characters per indentation level (default: 2). */
  tabsize?: number;
  /** Wrap long lines (default: true). */
  wrap?: boolean;
  /** Maximum line length when wrapping (default: 80). */
  wraplen?: number;
  /** Minimum line length before wrapping is attempted (default: 70). */
  wrapmin?: number;
  /** Indent with tabs instead of spaces (default: false). */
  usetabs?: boolean;
  /** Additional list environment names. */
  lists?: readonly string[];
  /** Additional verbatim environment names. */
  verbatims?: readonly string[];
  /** Environment names whose bodies should not be indented. */
  noIndentEnvs?: readonly string[];
  /** Enable alignment of LaTeX tables (default: false). */
  formatTables?: boolean;
};

/**
 * Result returned by `formatLatex`.
 */
export type TexFmtResult = {
  output: string;
  logs: string;
};

/**
 * Options for initializing the `tex-fmt` WebAssembly module.
 */
export type TexFmtInitOptions = {
  /** Custom URL to `tex_fmt_bg.wasm`. Defaults to the bundled WASM asset. */
  wasmUrl?: string | URL;
  /** Preloaded WASM bytes, Response, or compiled `WebAssembly.Module`. */
  wasmModule?: InitInput | Promise<InitInput>;
};

function escapeTomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Serializes `TexFmtOptions` into a `tex-fmt.toml` configuration string.
 */
export function buildTexFmtConfig(options: TexFmtOptions = {}): string {
  const lines: string[] = [];
  if (options.tabsize !== undefined) {
    lines.push(`tabsize = ${Math.max(0, Math.floor(options.tabsize))}`);
  }
  if (options.usetabs !== undefined) {
    lines.push(`tabchar = ${options.usetabs ? '"tab"' : '"space"'}`);
  }
  if (options.wrap !== undefined) {
    lines.push(`wrap = ${options.wrap ? "true" : "false"}`);
  }
  if (options.wraplen !== undefined) {
    lines.push(`wraplen = ${Math.max(1, Math.floor(options.wraplen))}`);
  }
  if (options.wrapmin !== undefined) {
    lines.push(`wrapmin = ${Math.max(1, Math.floor(options.wrapmin))}`);
  }
  if (options.lists?.length) {
    lines.push(`lists = [${options.lists.map(escapeTomlString).join(", ")}]`);
  }
  if (options.verbatims?.length) {
    lines.push(
      `verbatims = [${options.verbatims.map(escapeTomlString).join(", ")}]`,
    );
  }
  if (options.noIndentEnvs?.length) {
    lines.push(
      `no-indent-envs = [${options.noIndentEnvs.map(escapeTomlString).join(", ")}]`,
    );
  }
  if (options.formatTables !== undefined) {
    lines.push(`format-tables = ${options.formatTables ? "true" : "false"}`);
  }
  return lines.join("\n");
}

async function resolveDefaultWasmInput(): Promise<InitInput> {
  const url = new URL("./wasm/tex_fmt_bg.wasm", import.meta.url);
  // In Node/Bun (file: URL), fetch() does not always read local files, so read
  // directly from disk when running outside a browser/worker.
  if (url.protocol === "file:") {
    const specifier = "node:fs/promises";
    const fs = (await import(/* @vite-ignore */ specifier)) as {
      readFile: (path: URL) => Promise<Uint8Array>;
    };
    return fs.readFile(url);
  }
  return url;
}

let initialized: Promise<void> | undefined;

/**
 * Initializes the `tex-fmt` WebAssembly module. Safe to call multiple times;
 * subsequent calls reuse the initial promise.
 */
export function initTexFmt(options: TexFmtInitOptions = {}): Promise<void> {
  initialized ??= (async () => {
    const input =
      options.wasmModule ??
      options.wasmUrl ??
      (await resolveDefaultWasmInput());
    await initWasm({ module_or_path: input });
  })().catch((error) => {
    initialized = undefined;
    throw error;
  });
  return initialized;
}

/**
 * Formats LaTeX source code using the `tex-fmt` WebAssembly module.
 */
export async function formatLatex(
  input: string,
  options: TexFmtOptions = {},
): Promise<TexFmtResult> {
  await initTexFmt();
  const config = buildTexFmtConfig(options);
  const raw = wasmMain(input, config) as { output?: string; logs?: string };
  if (typeof raw?.output !== "string") {
    throw new Error("tex-fmt returned an unexpected result.");
  }
  return {
    output: raw.output,
    logs: typeof raw.logs === "string" ? raw.logs : "",
  };
}

/**
 * Creates a reusable formatter bound to specific WASM initialization options.
 */
export function createTexFmt(initOptions: TexFmtInitOptions = {}) {
  return {
    init: () => initTexFmt(initOptions),
    format: async (
      input: string,
      options: TexFmtOptions = {},
    ): Promise<TexFmtResult> => {
      await initTexFmt(initOptions);
      const config = buildTexFmtConfig(options);
      const raw = wasmMain(input, config) as { output?: string; logs?: string };
      if (typeof raw?.output !== "string") {
        throw new Error("tex-fmt returned an unexpected result.");
      }
      return {
        output: raw.output,
        logs: typeof raw.logs === "string" ? raw.logs : "",
      };
    },
  };
}
