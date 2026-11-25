/**
 * The installed wasm-latex-tools version. Its assets are served from a path with
 * this version, because browsers keep `/core/*` forever. Update it together with
 * the package; a test keeps the two equal.
 */
export const latexToolsVersion = "0.2.0";

export const latexToolsPath = `core/${latexToolsVersion}`;
