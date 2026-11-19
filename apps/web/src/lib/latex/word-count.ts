import { maskLatexSource } from "./analysis";

/**
 * Texcount-style word counting. Like texcount's default totals, body text,
 * headings and captions/footnotes are counted, while macros, math, comments,
 * verbatim material and the preamble are not.
 */
export type WordCounts = { text: number; headers: number; captions: number };

export type WordCountSection = WordCounts & {
  path: string;
  line: number;
  title: string;
  level: number;
};

export type WordCountFile = WordCounts & { path: string };

export type WordCount = WordCounts & {
  total: number;
  sections: WordCountSection[];
  files: WordCountFile[];
};

export const emptyWordCount: WordCount = {
  text: 0,
  headers: 0,
  captions: 0,
  total: 0,
  sections: [],
  files: [],
};

export type WordEvent =
  // `preamble` counts are kept outside the document body, like \title.
  | ({ type: "count"; preamble?: boolean } & WordCounts)
  | { type: "section"; level: number; title: string; line: number }
  | { type: "include"; target: string }
  | { type: "document"; open: boolean };

type Mode = keyof WordCounts | "ignore";

const sectionLevels = [
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
];

const mathEnvironments =
  /^(?:equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math|split|dmath|dgroup)\*?$/;
const ignoredEnvironments =
  /^(?:verbatim|Verbatim|lstlisting|minted|comment|tikzpicture|pgfpicture|picture|filecontents|thebibliography)\*?$/;
// Like texcount, float and table bodies are not counted, but captions and
// footnotes inside them are.
const uncountedBodies =
  /^(?:figure|table|wrapfigure|wraptable|sidewaysfigure|sidewaystable|tabular|tabularx|tabulary|array|longtable|tabu|supertabular|xtabular)\*?$/;
// Arguments to skip after \begin{env}: optional and required counts.
const environmentArguments: Record<string, number> = {
  minipage: 1,
  multicols: 1,
};
// Macros whose required arguments are not text, by number of arguments.
const ignoredMacros: Record<string, number> = {
  label: 1,
  ref: 1,
  eqref: 1,
  pageref: 1,
  autoref: 1,
  cref: 1,
  Cref: 1,
  nameref: 1,
  usepackage: 1,
  RequirePackage: 1,
  documentclass: 1,
  includegraphics: 1,
  bibliography: 1,
  bibliographystyle: 1,
  addbibresource: 1,
  url: 1,
  href: 1,
  hspace: 1,
  vspace: 1,
  setlength: 2,
  addtolength: 2,
  setcounter: 2,
  addtocounter: 2,
  pagestyle: 1,
  thispagestyle: 1,
  pagenumbering: 1,
  numberwithin: 2,
  graphicspath: 1,
  color: 1,
  textcolor: 1,
  colorbox: 1,
  definecolor: 3,
  hypersetup: 1,
  geometry: 1,
  newcommand: 2,
  renewcommand: 2,
  providecommand: 2,
  DeclareMathOperator: 2,
  newenvironment: 3,
  renewenvironment: 3,
  newtheorem: 2,
  author: 1,
  date: 1,
  thanks: 1,
  bibitem: 1,
  input: 1,
  include: 1,
  subfile: 1,
  includeonly: 1,
  rule: 2,
  raisebox: 1,
  multicolumn: 2,
  multirow: 2,
  cline: 1,
};
const captionMacros = /^(?:caption|footnote|footnotetext|marginpar)$/;
const citeMacro = /^(?:[a-z]*cite[a-z]*|nocite)$/i;
const accents = /^['"`^~=.]$/;
const wordCharacter = /[\p{L}\p{N}]/u;

function skipSpace(source: string, index: number) {
  while (/\s/.test(source[index] ?? "")) index++;
  return index;
}

function group(source: string, start: number, open = "{", close = "}") {
  if (source[start] !== open) return;
  let depth = 1;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === open) depth++;
    else if (source[index] === close && --depth === 0)
      return { text: source.slice(start + 1, index), end: index + 1 };
  }
  return { text: source.slice(start + 1), end: source.length };
}

/** Converts a file into word-count events that can be stitched across includes. */
export function wordEvents(text: string): WordEvent[] {
  const source = maskLatexSource(text);
  const events: WordEvent[] = [];
  const lineStarts = [0];
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1))
    lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let line = 0;
    while ((lineStarts[line + 1] ?? Infinity) <= offset) line++;
    return line + 1;
  };

  let inWord = false;
  let wordMode: Mode = "text";
  let preamble = false;
  function add(mode: keyof WordCounts) {
    const last = events.at(-1);
    if (last?.type === "count" && !last.preamble === !preamble) last[mode]++;
    else
      events.push({
        type: "count",
        text: 0,
        headers: 0,
        captions: 0,
        [mode]: 1,
        ...(preamble && { preamble }),
      });
  }
  function endWord() {
    if (!inWord) return;
    inWord = false;
    if (wordMode !== "ignore") add(wordMode);
  }
  function letter(mode: Mode) {
    if (!inWord) wordMode = mode;
    inWord = true;
  }

  function skipOptional(index: number) {
    let next = skipSpace(source, index);
    while (source[next] === "[") {
      next = skipSpace(source, group(source, next, "[", "]")?.end ?? next + 1);
    }
    return next;
  }
  function skipArguments(index: number, count: number) {
    let next = skipOptional(index);
    for (let n = 0; n < count; n++) {
      const value = group(source, next);
      if (!value) break;
      next = skipOptional(value.end);
    }
    return next;
  }
  function skipTo(index: number, end: string) {
    const found = source.indexOf(end, index);
    return found === -1 ? source.length : found + end.length;
  }

  /** Parses from `start` in `mode`; returns after the matching `}` if nested. */
  function run(
    start: number,
    mode: Mode,
    nested: boolean,
    end = source.length,
  ) {
    let index = start;
    while (index < end) {
      const char = source[index] ?? "";
      if (wordCharacter.test(char)) {
        letter(mode);
        index++;
        continue;
      }
      if (
        inWord &&
        /['’.-]/.test(char) &&
        wordCharacter.test(source[index + 1] ?? "")
      ) {
        index++;
        continue;
      }
      if (char === "{") {
        index = run(index + 1, mode, true, end);
        continue;
      }
      if (char === "}") {
        if (nested) return index + 1;
        endWord();
        index++;
        continue;
      }
      if (char === "$") {
        endWord();
        index =
          source[index + 1] === "$"
            ? skipTo(index + 2, "$$")
            : skipInlineMath(index + 1);
        continue;
      }
      if (char !== "\\") {
        endWord();
        index++;
        continue;
      }
      const next = source[index + 1] ?? "";
      if (accents.test(next)) {
        // \'e and \"{o} are part of the surrounding word.
        const after = source[index + 2] ?? "";
        if (after === "{" || wordCharacter.test(after)) {
          letter(mode);
          index =
            after === "{" ? (group(source, index + 2)?.end ?? end) : index + 3;
          continue;
        }
      }
      endWord();
      if (next === "(") {
        index = skipTo(index + 2, "\\)");
        continue;
      }
      if (next === "[") {
        index = skipTo(index + 2, "\\]");
        continue;
      }
      const name = /^[a-zA-Z@]+/.exec(source.slice(index + 1, index + 40))?.[0];
      if (!name) {
        // Skip \\[2pt] spacing along with the line break.
        index = next === "\\" ? skipOptional(index + 2) : index + 2;
        continue;
      }
      index += name.length + 1;
      if (source[index] === "*") index++;
      index = command(name, index, mode, end);
    }
    endWord();
    return index;
  }

  /** Parses one argument in a different mode, keeping words from spanning it. */
  function nestedRun(start: number, mode: Mode, end: number) {
    const after = run(start, mode, true, end);
    endWord();
    return after;
  }

  function skipInlineMath(index: number) {
    for (; index < source.length; index++) {
      if (source[index] === "\\") index++;
      else if (source[index] === "$") return index + 1;
    }
    return source.length;
  }

  function command(name: string, index: number, mode: Mode, end: number) {
    if (name === "begin" || name === "end") {
      const value = group(source, skipSpace(source, index));
      if (!value) return index;
      const environment = value.text.trim();
      if (environment === "document") {
        events.push({ type: "document", open: name === "begin" });
        return value.end;
      }
      if (name === "end") return value.end;
      if (
        mathEnvironments.test(environment) ||
        ignoredEnvironments.test(environment)
      )
        return skipTo(value.end, `\\end{${environment}}`);
      if (uncountedBodies.test(environment)) {
        const close = source.indexOf(`\\end{${environment}}`, value.end);
        const bodyEnd = close === -1 ? end : Math.min(close, end);
        run(skipOptional(value.end), "ignore", false, bodyEnd);
        return bodyEnd;
      }
      // texcount counts the abstract's implicit heading as one header word.
      if (environment === "abstract") add("headers");
      return skipArguments(value.end, environmentArguments[environment] ?? 0);
    }
    const level = sectionLevels.indexOf(name);
    if (level !== -1) {
      const short = group(source, skipSpace(source, index), "[", "]");
      const start = skipSpace(source, short?.end ?? index);
      const title = group(source, start);
      if (!title) return index;
      events.push({
        type: "section",
        level,
        line: lineAt(index),
        title:
          (short?.text ?? title.text)
            .replace(/\\[a-zA-Z]+\*?\s*/g, "")
            .replace(/[{}$]/g, "")
            .replace(/\s+/g, " ")
            .trim() || name,
      });
      return nestedRun(start + 1, mode === "ignore" ? mode : "headers", end);
    }
    if (name === "input" || name === "include" || name === "subfile") {
      const start = skipSpace(source, index);
      const value = group(source, start);
      const target =
        value?.text ??
        (name === "input"
          ? /^[^\s%{}\\]+/.exec(source.slice(start))?.[0]
          : undefined);
      if (target?.trim())
        events.push({ type: "include", target: target.trim() });
      return value?.end ?? start + (target?.length ?? 0);
    }
    if (captionMacros.test(name)) {
      const start = skipOptional(index);
      if (source[start] !== "{") return start;
      return nestedRun(start + 1, "captions", end);
    }
    if (name === "title") {
      const start = skipOptional(index);
      if (source[start] !== "{") return start;
      preamble = true;
      const after = nestedRun(start + 1, "headers", end);
      preamble = false;
      return after;
    }
    if (citeMacro.test(name)) return skipArguments(index, 1);
    if (name === "def") {
      const body = source.indexOf("{", index);
      return body === -1 ? end : (group(source, body)?.end ?? end);
    }
    if (Object.hasOwn(ignoredMacros, name))
      return skipArguments(index, ignoredMacros[name] ?? 0);
    // Unknown macros: drop the name and count their arguments as text.
    return index;
  }

  run(0, "text", false);
  return events;
}

function resolve(from: string, target: string, files: ReadonlySet<string>) {
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
    if (files.has(path)) return path;
    if (files.has(`${path}.tex`)) return `${path}.tex`;
  }
}

const zero = (): WordCounts => ({ text: 0, headers: 0, captions: 0 });

/** Totals a project's word count from its main file, following includes. */
export function countWords(
  events: ReadonlyMap<string, readonly WordEvent[]>,
  root: string | undefined,
): WordCount {
  const result: WordCount = { ...zero(), total: 0, sections: [], files: [] };
  const rootEvents = root ? events.get(root) : undefined;
  if (!root || !rootEvents) return result;
  const paths = new Set(events.keys());
  const files = new Map<string, WordCountFile>();
  // Like texcount, only the document body counts when the main file has one.
  let active = !rootEvents.some((event) => event.type === "document");
  let section: WordCountSection | undefined;
  const visiting = new Set<string>();

  function tally(path: string, counts: WordCounts) {
    if (!section) {
      section = { ...zero(), path, line: 1, title: "Front matter", level: -1 };
      result.sections.push(section);
    }
    let file = files.get(path);
    if (!file) files.set(path, (file = { ...zero(), path }));
    for (const key of ["text", "headers", "captions"] as const) {
      section[key] += counts[key];
      file[key] += counts[key];
      result[key] += counts[key];
    }
  }

  function walk(path: string) {
    const list = events.get(path);
    if (!list || visiting.has(path)) return;
    visiting.add(path);
    for (const event of list) {
      if (event.type === "document") active = event.open;
      else if (event.type === "count" && event.preamble) tally(path, event);
      else if (event.type === "include") {
        const target = resolve(path, event.target, paths);
        if (target) walk(target);
      } else if (!active) continue;
      else if (event.type === "section") {
        const { level, line, title } = event;
        section = { ...zero(), path, level, line, title };
        result.sections.push(section);
      } else if (event.type === "count") tally(path, event);
    }
    visiting.delete(path);
  }
  walk(root);
  result.total = result.text + result.headers + result.captions;
  result.files = [...files.values()];
  return result;
}
