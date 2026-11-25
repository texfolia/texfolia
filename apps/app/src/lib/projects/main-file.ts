/** Whether a file can be a project's main document. The compiler needs .tex. */
export function isMainFileCandidate(path: string) {
  return path.endsWith(".tex");
}

const depth = (path: string) => path.split("/").length;

/**
 * The document a project compiles: the chosen one while it exists, else
 * main.tex, else the first .tex file, outermost folders first.
 */
export function projectMainFile(
  paths: ReadonlyMap<string, string>,
  chosen: string | null | undefined,
): { id: string; path: string } | undefined {
  let fallback: { id: string; path: string } | undefined;
  let named: { id: string; path: string } | undefined;
  for (const [id, path] of paths) {
    if (!isMainFileCandidate(path)) continue;
    if (path === chosen) return { id, path };
    if (path === "main.tex") named = { id, path };
    if (
      !fallback ||
      depth(path) < depth(fallback.path) ||
      (depth(path) === depth(fallback.path) && path < fallback.path)
    )
      fallback = { id, path };
  }
  return named ?? fallback;
}

/**
 * Where the main document is after files moved, given the paths of every node
 * before and after.
 */
export function movedMainFile(
  mainFile: string | null,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
) {
  if (mainFile === null) return null;
  for (const [id, path] of before)
    if (path === mainFile) return after.get(id) ?? mainFile;
  return mainFile;
}
