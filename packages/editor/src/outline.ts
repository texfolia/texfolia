import { maskLatexSource } from "./analysis.js";

export type OutlineEntry = {
  path: string;
  line: number;
  title: string;
  level: number;
  children: OutlineEntry[];
};

const levels = [
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
];

function argument(source: string, start: number, open: string, close: string) {
  if (source[start] !== open) return;
  let depth = 1;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === open) depth++;
    if (source[index] === close && --depth === 0)
      return { text: source.slice(start + 1, index), end: index + 1 };
  }
}

function resolve(
  from: string,
  target: string,
  sources: ReadonlyMap<string, string>,
) {
  const normalize = (path: string) => {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  };
  const directory = from.split("/").slice(0, -1).join("/");
  for (const candidate of [target, `${directory}/${target}`]) {
    const path = normalize(candidate);
    if (sources.has(path)) return path;
    if (sources.has(`${path}.tex`)) return `${path}.tex`;
  }
}

export function projectOutline(
  sources: ReadonlyMap<string, string>,
  root: string | undefined,
): OutlineEntry[] {
  const result: OutlineEntry[] = [];
  const stack: OutlineEntry[] = [];
  const visiting = new Set<string>();
  function walk(path: string) {
    if (visiting.has(path)) return;
    const text = sources.get(path);
    if (text === undefined) return;
    visiting.add(path);
    const source = maskLatexSource(text);
    // Headings come in order, so each line count continues from the last.
    let counted = 0;
    let line = 1;
    const commands =
      /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|input|include)\b(\*)?\s*/g;
    for (
      let match = commands.exec(source);
      match;
      match = commands.exec(source)
    ) {
      const command = match[1];
      if (!command) continue;
      let start = commands.lastIndex;
      const short = argument(source, start, "[", "]");
      if (short) {
        start = short.end;
        while (/\s/.test(source[start] ?? "") && start < source.length) start++;
      }
      const value = argument(source, start, "{", "}");
      const unbraced =
        !value && command === "input"
          ? /^[^\s%{}]+/.exec(source.slice(start))?.[0]
          : undefined;
      if (!value && !unbraced) continue;
      commands.lastIndex = value?.end ?? start + (unbraced?.length ?? 0);
      const content = value?.text ?? unbraced ?? "";
      if (command === "input" || command === "include") {
        const target = resolve(path, content.trim(), sources);
        if (target) walk(target);
        continue;
      }
      const level = levels.indexOf(command);
      for (; counted < match.index; counted++)
        if (source.charCodeAt(counted) === 10) line++;
      const entry: OutlineEntry = {
        path,
        line,
        title:
          (short?.text ?? content)
            .replace(/\\(?:[a-zA-Z]+)\*?\s*/g, "")
            .replace(/[{}]/g, "")
            .trim() || command,
        level,
        children: [],
      };
      while (stack.length && (stack.at(-1)?.level ?? -1) >= level) stack.pop();
      (stack.at(-1)?.children ?? result).push(entry);
      stack.push(entry);
    }
    visiting.delete(path);
  }
  if (root) walk(root);
  return result;
}
