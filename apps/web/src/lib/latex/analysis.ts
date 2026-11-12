export type LatexProblem = {
  path: string;
  line: number;
  message: string;
  severity: "error" | "warning" | "info";
  range?: { from: number; to: number };
};

type SymbolAt = { key: string; from: number; to: number };
type FileSymbols = {
  text: string;
  labels: string[];
  citations: SymbolAt[];
  references: SymbolAt[];
  bibliography: SymbolAt[];
  includes: Array<SymbolAt & { command: string }>;
  packages: string[];
};

export type LatexAnalysis = {
  labels: string[];
  citations: string[];
  commands: string[];
  problems: LatexProblem[];
};

export const emptyAnalysis: LatexAnalysis = {
  labels: [],
  citations: [],
  commands: [],
  problems: [],
};

const citeCommand = /^(?:[a-z]*cite[a-z]*|nocite)\*?$/i;
const refCommand = /^(?:ref|eqref|autoref|pageref|cref)\*?$/i;
const texFile = /\.(?:tex|ltx|sty|cls)$/i;

function lineNumber(text: string) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
    starts.push(i + 1);
  return (offset: number) => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if ((starts[mid] ?? Infinity) <= offset) low = mid;
      else high = mid;
    }
    return low + 1;
  };
}

export function maskLatexSource(text: string) {
  // Mask comments and verbatim material while retaining CodeMirror offsets.
  return text.replace(
    /\\verb\*?(?<delimiter>[^\w\s])[^\n]*?\k<delimiter>|\\begin\{(?<literal>verbatim\*?|lstlisting|minted|Verbatim)\}[\s\S]*?(?=\\end\{\k<literal>\}|$)|\\[\\%]|%[^\r\n]*/g,
    (match, _delimiter: string | undefined, literal: string | undefined) =>
      literal
        ? match.slice(0, literal.length + 8) +
          match.slice(literal.length + 8).replace(/[^\r\n]/g, " ")
        : match === "\\\\" || match === "\\%"
          ? match
          : match.replace(/[^\r\n]/g, " "),
  );
}

export function scanFile(path: string, text: string): FileSymbols {
  const symbols: FileSymbols = {
    text,
    labels: [],
    citations: [],
    references: [],
    bibliography: [],
    includes: [],
    packages: [],
  };
  if (!texFile.test(path) && !/\.bib$/i.test(path)) return symbols;

  const source = maskLatexSource(text);

  if (/\.bib$/i.test(path)) {
    for (const match of source.matchAll(
      /@([a-z]+)\s*[{(]\s*([^\s,{}()]+)\s*,/gi,
    )) {
      const [, type, key] = match;
      if (!type || !key || /^(?:comment|string|preamble)$/i.test(type))
        continue;
      const from = match.index + match[0].lastIndexOf(key);
      symbols.bibliography.push({ key, from, to: from + key.length });
    }
    return symbols;
  }

  for (const match of source.matchAll(
    /\\\\|\\([a-zA-Z]+\*?)\s*(?:\[[^\]\r\n]*\]\s*){0,2}\{([^{}\r\n]*)\}/g,
  )) {
    const [, command, argument] = match;
    if (!command || argument === undefined) continue;
    const from = match.index + match[0].lastIndexOf("{") + 1;
    for (const part of argument.matchAll(/[^,]+/g)) {
      const key = part[0].trim();
      if (!key) continue;
      const start = from + part.index + part[0].indexOf(key);
      const symbol = { key, from: start, to: start + key.length };
      if (command === "label") symbols.labels.push(key);
      else if (refCommand.test(command)) symbols.references.push(symbol);
      else if (citeCommand.test(command)) symbols.citations.push(symbol);
      else if (command === "usepackage" || command === "RequirePackage")
        symbols.packages.push(key);
      else if (
        [
          "input",
          "include",
          "includegraphics",
          "bibliography",
          "addbibresource",
        ].includes(command.replace(/\*$/, ""))
      )
        symbols.includes.push({
          ...symbol,
          command: command.replace(/\*$/, ""),
        });
    }
  }
  return symbols;
}

const imageExtension = /\.(?:pdf|png|jpe?g|eps|svg|webp|bmp|tiff?)$/i;
export function isIncludePath(command: string, path: string) {
  if (command === "includegraphics") return imageExtension.test(path);
  if (command === "bibliography" || command === "addbibresource")
    return /\.bib$/i.test(path);
  return texFile.test(path);
}

export function analyzeProject(
  files: ReadonlyMap<string, FileSymbols>,
  paths: readonly string[],
  catalog: Record<string, readonly string[]>,
): LatexAnalysis {
  const labels = new Set<string>();
  const keys = new Set<string>();
  const cited = new Set<string>();
  const commands = new Set<string>();
  const problems: LatexProblem[] = [];
  const available = new Set(paths);
  const extensionless = new Set(
    paths.map((path) => path.replace(/\.[^/.]+$/, "")),
  );
  for (const file of files.values()) {
    for (const label of file.labels) labels.add(label);
    for (const entry of file.bibliography) keys.add(entry.key);
    for (const citation of file.citations) cited.add(citation.key);
    for (const pkg of file.packages)
      if (Object.hasOwn(catalog, pkg))
        for (const command of catalog[pkg] ?? []) commands.add(command);
  }

  for (const [path, file] of files) {
    let getLine: ReturnType<typeof lineNumber> | undefined;
    function report(
      symbol: SymbolAt,
      message: string,
      severity: "warning" | "info" = "warning",
    ) {
      getLine ??= lineNumber(file.text);
      const { from, to } = symbol;
      problems.push({
        path,
        line: getLine(from),
        message,
        severity,
        range: { from, to },
      });
    }
    for (const symbol of file.references)
      if (!labels.has(symbol.key))
        report(symbol, `Undefined label “${symbol.key}”`);
    for (const symbol of file.citations)
      if (symbol.key !== "*" && !keys.has(symbol.key))
        report(symbol, `Unknown citation “${symbol.key}”`);
    for (const symbol of file.bibliography)
      if (!cited.has("*") && !cited.has(symbol.key))
        report(symbol, `Unused bibliography entry “${symbol.key}”`, "info");
    for (const symbol of file.includes) {
      if (/[#\\{}]/.test(symbol.key)) continue; // TeX can expand dynamic paths.
      const target = symbol.key.replace(/^\.\//, "");
      const directory = path.slice(0, path.lastIndexOf("/") + 1);
      const candidates = [target, directory + target];
      if (
        !candidates.some(
          (name) => available.has(name) || extensionless.has(name),
        )
      )
        report(symbol, `Project file “${symbol.key}” was not found`);
    }
  }

  return {
    labels: [...labels].sort(),
    citations: [...keys].sort(),
    commands: [...commands].sort(),
    problems,
  };
}

export type AnalyzeRequest = {
  revision: number;
  paths: string[];
  updates: Array<[path: string, text: string]>;
};
export type AnalyzeResponse = { revision: number; analysis: LatexAnalysis };
