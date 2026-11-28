import { ensureSyntaxTree } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { Tree } from "@lezer/common";

import { parser } from "./parser.js";

export type LatexLinterOptions = {
  /** Optional filename for caller context. */
  fileName?: string;
  /** Check for unmatched `\begin{...}` and `\end{...}` pairs. Default: `true`. */
  checkEnvironments?: boolean;
  /** Check for unmatched `{` and `}` braces. Default: `true`. */
  checkBraces?: boolean;
  /** Check for unclosed `$`, `$$`, `\(`, `\[` math delimiters. Default: `true`. */
  checkMath?: boolean;
};

type OpenEnv = {
  name: string;
  from: number;
  to: number;
};

type OpenMath = {
  delim: "$" | "$$" | "\\(" | "\\[";
  from: number;
  to: number;
};

const SKIP_NODES = new Set([
  "Comment",
  "InlineVerbatim",
  "VerbatimContent",
  "EscapedChar",
]);

function readEnvName(
  slice: (from: number, to: number) => string,
  node: { getChild: (name: string) => { from: number; to: number } | null },
): string | null {
  const nameNode = node.getChild("EnvName");
  if (!nameNode || nameNode.from === nameNode.to) return null;
  return slice(nameNode.from, nameNode.to).trim();
}

function getTree(view: EditorView): Tree {
  const existing = ensureSyntaxTree(view.state, view.state.doc.length, 500);
  if (existing && existing.topNode.name === "Document") {
    return existing;
  }
  return parser.parse(view.state.doc.toString());
}

/**
 * Syntax linter driven by the Lezer LaTeX syntax tree. Checks balanced
 * `\begin`/`\end` environments, `{}` braces, and math delimiters while
 * skipping comments, escapes, `\verb|...|`, and verbatim environments.
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
    const tree = getTree(view);
    const slice = (from: number, to: number) => view.state.sliceDoc(from, to);
    const diagnostics: Diagnostic[] = [];

    const envStack: OpenEnv[] = [];
    const braceStack: number[] = [];
    const mathState: { open: OpenMath | null } = { open: null };

    function handleEndEnv(envName: string, from: number, to: number) {
      if (!checkEnvironments) return;
      const top = envStack.at(-1);
      if (!top) {
        diagnostics.push({
          from,
          to,
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
            from,
            to,
            severity: "error",
            message: `Mismatched \\end{${envName}}; expected \\end{${top.name}}`,
          });
        }
      }
    }

    tree.iterate({
      enter(ref) {
        if (SKIP_NODES.has(ref.name)) return false;
        // Skip zero-width synthetic tokens inserted by Lezer error recovery.
        if (ref.from === ref.to) return;

        switch (ref.name) {
          case "BeginEnv":
          case "BeginMathEnv":
          case "BeginVerbatimEnv": {
            const envName = readEnvName(slice, ref.node);
            if (checkEnvironments && envName) {
              envStack.push({ name: envName, from: ref.from, to: ref.to });
            }
            // Braces around the environment name are part of the directive itself.
            return false;
          }

          case "EndEnv": {
            const envName = readEnvName(slice, ref.node);
            if (envName) {
              handleEndEnv(envName, ref.from, ref.to);
            }
            return false;
          }

          case "EndCommand": {
            // Orphan `\end{...}` at top level sits inside an error node rather than EndEnv.
            const parent = ref.node.parent;
            if (parent && parent.name !== "EndEnv") {
              const after = slice(
                ref.to,
                Math.min(view.state.doc.length, ref.to + 80),
              );
              const match = /^[ \t]*\{([^}\n]+)\}/.exec(after);
              if (match) {
                const envName = match[1]!.trim();
                handleEndEnv(envName, ref.from, ref.to + match[0].length);
              }
            }
            return false;
          }

          case "{": {
            if (checkBraces) {
              const parent = ref.node.parent;
              const isOrphanEndBrace =
                parent?.name === "⚠" &&
                ref.node.prevSibling?.name === "EndCommand";
              if (!isOrphanEndBrace) {
                braceStack.push(ref.from);
              }
            }
            return;
          }

          case "}": {
            if (checkBraces) {
              const parent = ref.node.parent;
              const isOrphanEndBrace =
                parent?.name === "⚠" &&
                ref.node.prevSibling?.prevSibling?.prevSibling?.name ===
                  "EndCommand";
              if (isOrphanEndBrace) return;
              if (braceStack.length === 0) {
                diagnostics.push({
                  from: ref.from,
                  to: ref.to,
                  severity: "error",
                  message: "Unmatched closing brace “}”",
                });
              } else {
                braceStack.pop();
              }
            }
            return;
          }

          case "OpenInlineMath":
          case "OpenDisplayMath": {
            if (!checkMath) return;
            const delim = ref.name === "OpenInlineMath" ? "\\(" : "\\[";
            if (mathState.open) {
              diagnostics.push({
                from: ref.from,
                to: ref.to,
                severity: "error",
                message: `Nested math delimiter ${delim} inside unclosed ${mathState.open.delim}`,
              });
            } else {
              mathState.open = { delim, from: ref.from, to: ref.to };
            }
            return;
          }

          case "CloseInlineMath":
          case "CloseDisplayMath": {
            if (!checkMath) return;
            const closeChar = ref.name === "CloseInlineMath" ? ")" : "]";
            const expected = ref.name === "CloseInlineMath" ? "\\(" : "\\[";
            if (!mathState.open) {
              diagnostics.push({
                from: ref.from,
                to: ref.to,
                severity: "error",
                message: `Unexpected closing math delimiter \\${closeChar}`,
              });
            } else if (mathState.open.delim !== expected) {
              diagnostics.push({
                from: ref.from,
                to: ref.to,
                severity: "error",
                message: `Mismatched math delimiter: expected closing for ${mathState.open.delim}, found \\${closeChar}`,
              });
              mathState.open = null;
            } else {
              mathState.open = null;
            }
            return;
          }

          case "SingleDollar":
          case "DoubleDollar": {
            if (!checkMath) return;
            const delim = ref.name === "DoubleDollar" ? "$$" : "$";
            if (!mathState.open) {
              mathState.open = { delim, from: ref.from, to: ref.to };
            } else if (mathState.open.delim === delim) {
              mathState.open = null;
            } else {
              diagnostics.push({
                from: ref.from,
                to: ref.to,
                severity: "error",
                message: `Mismatched math delimiter: expected ${mathState.open.delim}, found ${delim}`,
              });
              mathState.open = null;
            }
            return;
          }
        }
      },
    });

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

    if (checkMath && mathState.open) {
      diagnostics.push({
        from: mathState.open.from,
        to: mathState.open.to,
        severity: "error",
        message: `Unclosed math delimiter ${mathState.open.delim}`,
      });
    }

    return diagnostics;
  };
}
