import { EditorSelection, type StateCommand } from "@codemirror/state";

import { maskLatexSource } from "./analysis.js";
import catalog from "./symbols.json" with { type: "json" };

export type LatexSymbol = (typeof catalog)[number];
export const latexSymbols = catalog;

export function searchLatexSymbols(query: string) {
  const terms = query.trim().toLowerCase().replaceAll("\\", "").split(/\s+/);
  return latexSymbols.filter((symbol) => {
    const text =
      `${symbol.name} ${symbol.command} ${symbol.category} ${symbol.keywords.join(" ")}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function latexPreamble(text: string) {
  const source = maskLatexSource(text);
  const packages = new Set<string>();
  let insertAt = 0;
  for (const match of source.matchAll(
    /\\\\|\\(documentclass|usepackage|RequirePackage|begin)\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g,
  )) {
    const [, command, argument] = match;
    if (!command || argument === undefined) continue;
    if (command === "begin" && argument.trim() === "document") {
      if (!insertAt) insertAt = match.index;
      break;
    }
    if (command === "begin") continue;
    if (command !== "documentclass") {
      for (const name of argument.split(",")) packages.add(name.trim());
    }
    const end = match.index + match[0].length;
    const newline = source.indexOf("\n", end);
    insertAt =
      newline !== -1 && !source.slice(end, newline).trim() ? newline + 1 : end;
  }
  // These packages load the corresponding base package themselves.
  if (packages.has("amssymb")) packages.add("amsfonts");
  if (packages.has("mathtools")) packages.add("amsmath");
  return { packages, insertAt };
}

export function packageInsertion(source: string, packageName: string) {
  const { packages, insertAt } = latexPreamble(source);
  if (packages.has(packageName)) return null;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const prefix = insertAt && source[insertAt - 1] !== "\n" ? newline : "";
  return {
    from: insertAt,
    insert: `${prefix}\\usepackage{${packageName}}${newline}`,
  };
}

export function addLatexPackage(packageName: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const changes = packageInsertion(state.doc.toString(), packageName);
    if (!changes) return false;
    dispatch(
      state.update({
        changes,
        userEvent: "input.package",
        scrollIntoView: false,
      }),
    );
    return true;
  };
}

export function insertLatexSymbol(symbol: LatexSymbol): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    // Empty braces keep a following letter from becoming part of the command.
    dispatch(
      state.update(
        state.changeByRange((range) => {
          const next = state.sliceDoc(range.to, range.to + 1);
          const insert =
            symbol.command +
            (/[a-z]$/i.test(symbol.command) && /^[a-z]/i.test(next)
              ? "{}"
              : "");
          return {
            changes: { from: range.from, to: range.to, insert },
            range: EditorSelection.cursor(range.from + insert.length),
          };
        }),
        { userEvent: "input.symbol", scrollIntoView: true },
      ),
    );
    return true;
  };
}
