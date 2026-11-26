import {
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";

import { isIncludePath, type LatexAnalysis } from "./analysis.js";

function prefixed(
  values: readonly string[],
  prefix: string,
  type: string,
): Completion[] {
  let start = 0;
  let end = values.length;
  while (start < end) {
    const mid = (start + end) >>> 1;
    if ((values[mid] ?? "") < prefix) start = mid + 1;
    else end = mid;
  }
  const options: Completion[] = [];
  for (let i = start; i < values.length && options.length < 100; i++) {
    const label = values[i];
    if (!label?.startsWith(prefix)) break;
    options.push({ label, type });
  }
  return options;
}

export function latexCompletion(
  getAnalysis: () => LatexAnalysis,
  paths: readonly string[],
): CompletionSource {
  const fileOptions = new Map(
    ["input", "include", "includegraphics"].map((command) => [
      command,
      paths.filter((path) => isIncludePath(command, path)).sort(),
    ]),
  );
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(
      Math.max(line.from, context.pos - 250),
      context.pos,
    );
    if (/(?:^|[^\\])(?:\\\\)*%/.test(before)) return null;
    const argument =
      /\\([a-z]+)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{(?:[^{}]*,\s*)?([^{}\s,]*)$/i.exec(
        before,
      );
    const [, argumentCommand, prefix] = argument ?? [];
    if (argumentCommand && prefix !== undefined) {
      const command = argumentCommand;
      const analysis = getAnalysis();
      const options = /^(?:[a-z]*cite[a-z]*|nocite)$/i.test(command)
        ? prefixed(analysis.citations, prefix, "constant")
        : /^(?:ref|eqref|autoref|pageref|cref)$/i.test(command)
          ? prefixed(analysis.labels, prefix, "reference")
          : prefixed(fileOptions.get(command) ?? [], prefix, "file");
      return options.length
        ? { from: context.pos - prefix.length, options }
        : null;
    }

    const command = /(?:^|[^\\])(?:\\\\)*(\\[a-zA-Z]*)$/.exec(before)?.[1];
    if (!command) return null;
    const commands = getAnalysis().commands;
    return {
      from: context.pos - command.length,
      options: prefixed(commands, command, "function"),
    };
  };
}
