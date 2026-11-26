import type { Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";

export type LatexLinterOptions = {
  /** Optional filename (used to skip linting on `.sty`/`.cls` if desired). */
  fileName?: string;
  /** Check for unmatched `\begin{...}` and `\end{...}` pairs. Default: `true`. */
  checkEnvironments?: boolean;
  /** Check for unmatched `{` and `}` braces. Default: `true`. */
  checkBraces?: boolean;
  /** Check for unclosed `$`, `$$`, `\(`, `\[` math delimiters. Default: `true`. */
  checkMath?: boolean;
};

const VERBATIM_ENVS = new Set([
  "verbatim",
  "verbatim*",
  "lstlisting",
  "minted",
  "Verbatim",
  "BVerbatim",
  "LVerbatim",
  "alltt",
  "comment",
]);

/**
 * Clean-room LaTeX syntax linter returning a CodeMirror lint source function.
 * Checks balanced `\begin`/`\end` environments, `{}` braces, and math delimiters
 * while skipping comments, escaped characters, `\verb|...|`, and verbatim blocks.
 */
export function latexLinter(
  options: LatexLinterOptions = {},
): (view: EditorView) => Diagnostic[] {
  const {
    checkEnvironments = true,
    checkBraces = true,
    checkMath = true,
  } = options;

  return (view: EditorView): Diagnostic[] => {
    const text = view.state.doc.toString();
    const diagnostics: Diagnostic[] = [];

    const envStack: Array<{ name: string; from: number; to: number }> = [];
    const braceStack: number[] = [];
    let mathOpen: {
      delim: "$" | "$$" | "\\(" | "\\[";
      from: number;
      to: number;
    } | null = null;

    let i = 0;
    const len = text.length;

    while (i < len) {
      const ch = text[i];

      // Line comment: skip to newline
      if (ch === "%") {
        const nl = text.indexOf("\n", i + 1);
        i = nl === -1 ? len : nl + 1;
        continue;
      }

      // Backslash command or escape
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === undefined) break;

        // Inline / display math delimiters: \( \) \[ \]
        if (next === "(" || next === "[") {
          const delim = next === "(" ? "\\(" : "\\[";
          if (checkMath) {
            if (mathOpen) {
              diagnostics.push({
                from: i,
                to: i + 2,
                severity: "error",
                message: `Nested math delimiter ${delim} inside unclosed ${mathOpen.delim}`,
              });
            } else {
              mathOpen = { delim, from: i, to: i + 2 };
            }
          }
          i += 2;
          continue;
        }
        if (next === ")" || next === "]") {
          const expected = next === ")" ? "\\(" : "\\[";
          if (checkMath) {
            if (!mathOpen) {
              diagnostics.push({
                from: i,
                to: i + 2,
                severity: "error",
                message: `Unexpected closing math delimiter \\${next}`,
              });
            } else if (mathOpen.delim !== expected) {
              diagnostics.push({
                from: i,
                to: i + 2,
                severity: "error",
                message: `Mismatched math delimiter: expected closing for ${mathOpen.delim}, found \\${next}`,
              });
              mathOpen = null;
            } else {
              mathOpen = null;
            }
          }
          i += 2;
          continue;
        }

        // Single non-letter escape (\\, \{, \}, \%, \$, etc.)
        if (!/[a-zA-Z@]/.test(next)) {
          i += 2;
          continue;
        }

        // Control word
        const cmdStart = i;
        let j = i + 1;
        while (j < len && /[a-zA-Z@]/.test(text[j] ?? "")) j++;
        const cmdName = text.slice(cmdStart + 1, j);
        if (text[j] === "*") j++;

        // \verb|...| or \verb*|...|
        if (cmdName === "verb" && j < len && !/\s/.test(text[j] ?? "")) {
          const delimiter = text[j]!;
          const end = text.indexOf(delimiter, j + 1);
          const nl = text.indexOf("\n", j + 1);
          if (end !== -1 && (nl === -1 || end < nl)) {
            i = end + 1;
          } else {
            i = nl === -1 ? len : nl + 1;
          }
          continue;
        }

        // \begin{env} / \end{env}
        if (cmdName === "begin" || cmdName === "end") {
          let k = j;
          while (k < len && (text[k] === " " || text[k] === "\t")) k++;
          if (text[k] === "{") {
            const close = text.indexOf("}", k + 1);
            const nl = text.indexOf("\n", k + 1);
            if (close !== -1 && (nl === -1 || close < nl)) {
              const envName = text.slice(k + 1, close).trim();
              const endPos = close + 1;

              if (cmdName === "begin") {
                if (VERBATIM_ENVS.has(envName)) {
                  const endTag = `\\end{${envName}}`;
                  const endIdx = text.indexOf(endTag, endPos);
                  if (endIdx === -1) {
                    if (checkEnvironments) {
                      diagnostics.push({
                        from: cmdStart,
                        to: endPos,
                        severity: "error",
                        message: `Unclosed environment “${envName}”`,
                      });
                    }
                    i = len;
                  } else {
                    i = endIdx + endTag.length;
                  }
                  continue;
                }
                if (checkEnvironments) {
                  envStack.push({ name: envName, from: cmdStart, to: endPos });
                }
              } else if (checkEnvironments) {
                const top = envStack.at(-1);
                if (!top) {
                  diagnostics.push({
                    from: cmdStart,
                    to: endPos,
                    severity: "error",
                    message: `Unexpected \\end{${envName}} without matching \\begin`,
                  });
                } else if (top.name === envName) {
                  envStack.pop();
                } else {
                  const matchIdx = envStack.findLastIndex(
                    (entry) => entry.name === envName,
                  );
                  if (matchIdx !== -1) {
                    while (envStack.length - 1 > matchIdx) {
                      const unclosed = envStack.pop()!;
                      diagnostics.push({
                        from: unclosed.from,
                        to: unclosed.to,
                        severity: "error",
                        message: `Unclosed environment “${unclosed.name}”`,
                      });
                    }
                    envStack.pop();
                  } else {
                    diagnostics.push({
                      from: cmdStart,
                      to: endPos,
                      severity: "error",
                      message: `Mismatched \\end{${envName}}; expected \\end{${top.name}}`,
                    });
                  }
                }
              }
              i = endPos;
              continue;
            }
          }
        }

        i = j;
        continue;
      }

      // Math delimiters $ and $$
      if (ch === "$") {
        const isDouble = text[i + 1] === "$";
        const delim = isDouble ? "$$" : "$";
        const width = isDouble ? 2 : 1;
        if (checkMath) {
          if (!mathOpen) {
            mathOpen = { delim, from: i, to: i + width };
          } else if (mathOpen.delim === delim) {
            mathOpen = null;
          } else {
            diagnostics.push({
              from: i,
              to: i + width,
              severity: "error",
              message: `Mismatched math delimiter: expected ${mathOpen.delim}, found ${delim}`,
            });
            mathOpen = null;
          }
        }
        i += width;
        continue;
      }

      // Braces { and }
      if (ch === "{") {
        if (checkBraces) braceStack.push(i);
        i++;
        continue;
      }
      if (ch === "}") {
        if (checkBraces) {
          if (braceStack.length === 0) {
            diagnostics.push({
              from: i,
              to: i + 1,
              severity: "error",
              message: "Unmatched closing brace “}”",
            });
          } else {
            braceStack.pop();
          }
        }
        i++;
        continue;
      }

      i++;
    }

    if (checkEnvironments) {
      for (const unclosed of envStack) {
        diagnostics.push({
          from: unclosed.from,
          to: unclosed.to,
          severity: "error",
          message: `Unclosed environment “${unclosed.name}”`,
        });
      }
    }

    if (checkBraces) {
      for (const pos of braceStack) {
        diagnostics.push({
          from: pos,
          to: pos + 1,
          severity: "error",
          message: "Unclosed brace “{”",
        });
      }
    }

    if (checkMath && mathOpen) {
      diagnostics.push({
        from: mathOpen.from,
        to: mathOpen.to,
        severity: "error",
        message: `Unclosed math delimiter ${mathOpen.delim}`,
      });
    }

    return diagnostics;
  };
}
