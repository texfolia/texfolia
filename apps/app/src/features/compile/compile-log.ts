// Structurally a subset of the editor's `LatexProblem`, so the app can show
// these with its own analysis without this feature depending on the editor.
export type CompileProblem = {
  path: string;
  line: number;
  message: string;
  severity: "error" | "warning" | "info";
};

export function parseCompileLog(
  log: string,
  paths: readonly string[],
  main: string,
): CompileProblem[] {
  const known = new Set(paths);
  const stems = new Map<string, string | null>();
  for (const path of paths) {
    const stem = path.replace(/\.[^/.]+$/, "");
    stems.set(stem, stems.has(stem) ? null : path);
  }
  function projectPath(raw: string) {
    const clean = raw.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
    if (known.has(clean)) return clean;
    const direct = stems.get(clean);
    if (direct) return direct;
    for (
      let offset = clean.indexOf("/");
      offset !== -1;
      offset = clean.indexOf("/", offset + 1)
    ) {
      const suffix = clean.slice(offset + 1);
      if (known.has(suffix)) return suffix;
      const match = stems.get(suffix);
      if (match) return match;
    }
  }
  const result = new Map<string, CompileProblem>();
  const stack: Array<string | undefined> = [];
  let current = main;
  let pendingError: { path: string; message: string } | undefined;

  function add(
    path: string,
    line: number,
    severity: "error" | "warning",
    message: string,
  ) {
    if (!Number.isSafeInteger(line) || line < 1) return;
    const key = JSON.stringify([
      path,
      line,
      severity,
      message.replace(/\.$/, ""),
    ]);
    if (!result.has(key)) result.set(key, { path, line, message, severity });
  }

  for (const entry of log.split(/\r?\n/)) {
    const located =
      /^(?:(error|warning):\s*)?(.+?):(\d+)(?::\d+)?:\s*(.+)$/.exec(entry);
    if (located) {
      const [, kind, file, line, message] = located;
      const path = file && projectPath(file);
      if (path && message) {
        add(
          path,
          Number(line),
          kind === "warning" ? "warning" : "error",
          message,
        );
        continue;
      }
    }
    const error = /^!\s+(.+)$/.exec(entry);
    if (error?.[1]) {
      pendingError = { path: current, message: error[1] };
      continue;
    }
    const lineNumber = /^l\.(\d+)\b/.exec(entry);
    if (lineNumber && pendingError) {
      add(
        pendingError.path,
        Number(lineNumber[1]),
        "error",
        pendingError.message,
      );
      pendingError = undefined;
      continue;
    }
    const warning =
      /^(?:(?:LaTeX|Package \S+|Class \S+) Warning:|(?:Over|Under)full\b).*?\b(?:input line|at lines?)\s+(\d+)/i.exec(
        entry,
      );
    if (warning) {
      add(current, Number(warning[1]), "warning", entry.trim());
      continue;
    }

    // TeX's transcript opens source files with "(./path" and closes them with ")".
    for (const token of entry.matchAll(/\(("[^"]+"|[^()\s]+)?|\)/g)) {
      if (token[0].startsWith("(")) {
        stack.push(token[1] ? projectPath(token[1]) : undefined);
      } else {
        stack.pop();
      }
      current = [...stack].reverse().find((path) => path !== undefined) ?? main;
    }
  }
  return [...result.values()];
}
