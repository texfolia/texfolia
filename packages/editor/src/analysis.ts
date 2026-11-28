import { bibEntryKeys, similarKeys } from "./bibtex.js";
import type { WordCount } from "./word-count.js";

export type LatexProblem = {
  path: string;
  line: number;
  message: string;
  severity: "error" | "warning" | "info";
  range?: { from: number; to: number };
  /** An undefined \\cite key, with defined keys it may be a typo of. */
  citation?: { key: string; suggestions: string[] };
  /** An image file in the project that no \\includegraphics references. */
  unusedAsset?: { path: string };
};

type SymbolAt = { key: string; from: number; to: number };
type FileSymbols = {
  text: string;
  labels: string[];
  citations: SymbolAt[];
  references: SymbolAt[];
  bibliography: SymbolAt[];
  includes: Array<SymbolAt & { command: string }>;
  graphicsPaths: string[];
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
    graphicsPaths: [],
    packages: [],
  };
  if (!texFile.test(path) && !/\.bib$/i.test(path)) return symbols;

  const source = maskLatexSource(text);

  if (/\.bib$/i.test(path)) {
    symbols.bibliography = bibEntryKeys(source);
    return symbols;
  }

  for (const match of source.matchAll(
    /\\graphicspath\s*\{((?:\s*\{[^{}\r\n]*\}\s*)+)\}/g,
  )) {
    const body = match[1];
    if (!body) continue;
    for (const dirMatch of body.matchAll(/\{([^{}\r\n]*)\}/g)) {
      const raw = dirMatch[1]?.trim();
      if (raw === undefined) continue;
      const cleaned = raw.replace(/^(?:\.\/)+/, "");
      const dir = cleaned && !cleaned.endsWith("/") ? `${cleaned}/` : cleaned;
      symbols.graphicsPaths.push(dir);
    }
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
const unusedImageAssetExtension =
  /\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg|eps|avif)$/i;

export function isIncludePath(command: string, path: string) {
  if (command === "includegraphics") return imageExtension.test(path);
  if (command === "bibliography" || command === "addbibresource")
    return /\.bib$/i.test(path);
  return texFile.test(path);
}

function normalizeRelativePath(path: string) {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
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
  const byExtensionless = new Map<string, string[]>();
  for (const projectPath of paths) {
    const stem = projectPath.replace(/\.[^/.]+$/, "");
    const list = byExtensionless.get(stem);
    if (list) list.push(projectPath);
    else byExtensionless.set(stem, [projectPath]);
  }
  const graphicsPaths = new Set<string>();
  const referencedAssets = new Set<string>();
  // The first definition of each key, without case as BibTeX compares them.
  const defined = new Map<string, { path: string; from: number }>();
  const duplicates = new Map<SymbolAt, { path: string; from: number }>();
  for (const [path, file] of files) {
    for (const label of file.labels) labels.add(label);
    for (const entry of file.bibliography) {
      keys.add(entry.key);
      const first = defined.get(entry.key.toLowerCase());
      if (first) duplicates.set(entry, first);
      else defined.set(entry.key.toLowerCase(), { path, from: entry.from });
    }
    for (const citation of file.citations) cited.add(citation.key);
    for (const gp of file.graphicsPaths) graphicsPaths.add(gp);
    for (const pkg of file.packages)
      if (Object.hasOwn(catalog, pkg))
        for (const command of catalog[pkg] ?? []) commands.add(command);
  }

  const sortedKeys = [...keys].sort();
  const lines = new Map<string, ReturnType<typeof lineNumber>>();
  const lineIn = (path: string, offset: number) => {
    let getLine = lines.get(path);
    if (!getLine) {
      getLine = lineNumber(files.get(path)?.text ?? "");
      lines.set(path, getLine);
    }
    return getLine(offset);
  };
  const suggestions = new Map<string, string[]>();
  for (const [path, file] of files) {
    function report(
      symbol: SymbolAt,
      message: string,
      severity: "warning" | "info" = "warning",
      extra: Partial<LatexProblem> = {},
    ) {
      const { from, to } = symbol;
      problems.push({
        path,
        line: lineIn(path, from),
        message,
        severity,
        range: { from, to },
        ...extra,
      });
    }
    for (const symbol of file.references)
      if (!labels.has(symbol.key))
        report(symbol, `Undefined label “${symbol.key}”`);
    for (const symbol of file.citations)
      if (symbol.key !== "*" && !keys.has(symbol.key)) {
        let similar = suggestions.get(symbol.key);
        if (!similar) {
          similar = similarKeys(symbol.key, sortedKeys);
          suggestions.set(symbol.key, similar);
        }
        report(symbol, `Unknown citation “${symbol.key}”`, "warning", {
          citation: { key: symbol.key, suggestions: similar },
        });
      }
    for (const symbol of file.bibliography) {
      const first = duplicates.get(symbol);
      if (first)
        report(
          symbol,
          `Duplicate bibliography key “${symbol.key}” (first defined in ${first.path}, line ${lineIn(first.path, first.from)})`,
        );
      else if (!cited.has("*") && !cited.has(symbol.key))
        report(symbol, `Unused bibliography entry “${symbol.key}”`, "info");
    }
    for (const symbol of file.includes) {
      if (/[#\\{}]/.test(symbol.key)) continue; // TeX can expand dynamic paths.
      const directory = path.slice(0, path.lastIndexOf("/") + 1);
      const candidates = new Set<string>([
        normalizeRelativePath(symbol.key),
        normalizeRelativePath(directory + symbol.key),
      ]);
      if (symbol.command === "includegraphics") {
        for (const gp of graphicsPaths) {
          candidates.add(normalizeRelativePath(gp + symbol.key));
          if (directory)
            candidates.add(normalizeRelativePath(directory + gp + symbol.key));
        }
      }
      let found = false;
      for (const candidate of candidates) {
        if (available.has(candidate)) {
          found = true;
          if (symbol.command === "includegraphics")
            referencedAssets.add(candidate);
        }
        const matches = byExtensionless.get(candidate);
        if (matches) {
          found = true;
          if (symbol.command === "includegraphics")
            for (const matched of matches) referencedAssets.add(matched);
        }
      }
      if (!found) report(symbol, `Project file “${symbol.key}” was not found`);
    }
  }

  if (paths.some((projectPath) => texFile.test(projectPath))) {
    for (const assetPath of [...paths].sort()) {
      if (
        unusedImageAssetExtension.test(assetPath) &&
        !referencedAssets.has(assetPath)
      ) {
        problems.push({
          path: assetPath,
          line: 1,
          message: `Unused image “${assetPath}”`,
          severity: "info",
          unusedAsset: { path: assetPath },
        });
      }
    }
  }

  return {
    labels: [...labels].sort(),
    citations: sortedKeys,
    commands: [...commands].sort(),
    problems,
  };
}

export type AnalyzeRequest = {
  revision: number;
  paths: string[];
  /** Root file for the word count. */
  main?: string;
  updates: Array<[path: string, text: string]>;
};
export type AnalyzeResponse = {
  revision: number;
  analysis: LatexAnalysis;
  words: WordCount;
};
