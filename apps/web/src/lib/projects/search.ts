export type ProjectSearchEdit = {
  from: number;
  to: number;
  insert: string;
};

export type ProjectSearchMatch = {
  path: string;
  line: number;
  column: number;
  /** UTF-16 offsets of the match within the full file text. */
  from: number;
  to: number;
  /** The matched text. */
  match: string;
  /** The substituted text when `replacement` is provided. */
  replacement?: string;
  /** The matched line, trimmed around the match when it is long. */
  preview: string;
  /** Match offsets within `preview`. */
  start: number;
  end: number;
};

export type ProjectSearchResult = {
  files: { path: string; matches: ProjectSearchMatch[] }[];
  total: number;
  truncated: boolean;
  error?: string;
};

export type ProjectSearchOptions = {
  matchCase?: boolean;
  regex?: boolean;
  limit?: number;
  replacement?: string;
};

const previewContext = 40;

function formatRegexError(error: unknown) {
  if (!(error instanceof Error)) return "Invalid regular expression.";
  const prefix = /^Invalid regular expression: \/.*\/[a-z]*: /;
  return error.message.replace(prefix, "Invalid regular expression: ");
}

function compileSearchPattern(
  query: string,
  {
    matchCase = false,
    regex = false,
  }: { matchCase?: boolean; regex?: boolean },
): { pattern: RegExp } | { error: string } | null {
  if (!query || query.includes("\n") || query.includes("\r")) return null;
  const flags = matchCase ? "g" : "gi";
  if (!regex) {
    // An escaped literal keeps case-insensitive offsets aligned with the source.
    return {
      pattern: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags),
    };
  }
  try {
    return { pattern: new RegExp(query, flags) };
  } catch (error) {
    return { error: formatRegexError(error) };
  }
}

function* eachLine(text: string) {
  let line = 1;
  let offset = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    yield { line, offset, content: text.slice(offset, match.index) };
    offset = match.index + match[0].length;
    line++;
  }
  yield { line, offset, content: text.slice(offset) };
}

/**
 * Expands JavaScript regex replacement syntax (`$$`, `$&`, `` $` ``, `$'`,
 * `$1`–`$99`, `$<name>`) against one line match.
 */
function expandRegexReplacement(
  template: string,
  found: RegExpMatchArray,
  line: string,
) {
  const index = found.index ?? 0;
  const matched = found[0];
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    if (ch !== "$" || i + 1 >= template.length) {
      out += ch;
      continue;
    }
    const next = template[i + 1]!;
    if (next === "$") {
      out += "$";
      i++;
    } else if (next === "&") {
      out += matched;
      i++;
    } else if (next === "`") {
      out += line.slice(0, index);
      i++;
    } else if (next === "'") {
      out += line.slice(index + matched.length);
      i++;
    } else if (next === "<") {
      const close = template.indexOf(">", i + 2);
      if (close !== -1 && found.groups) {
        out += found.groups[template.slice(i + 2, close)] ?? "";
        i = close;
      } else {
        out += "$";
      }
    } else if (next >= "0" && next <= "9") {
      const two =
        i + 2 < template.length &&
        template[i + 2]! >= "0" &&
        template[i + 2]! <= "9"
          ? Number(template.slice(i + 1, i + 3))
          : 0;
      const one = Number(next);
      if (two >= 1 && two < found.length) {
        out += found[two] ?? "";
        i += 2;
      } else if (one >= 1 && one < found.length) {
        out += found[one] ?? "";
        i++;
      } else {
        out += "$";
      }
    } else {
      out += "$";
    }
  }
  return out;
}

function resolveReplacement(
  replacement: string,
  found: RegExpMatchArray,
  line: string,
  regex: boolean,
) {
  return regex ? expandRegexReplacement(replacement, found, line) : replacement;
}

/**
 * Finds literal or regex occurrences of `query` in project text files. Matches
 * do not span lines, and `limit` caps the total so a short query stays
 * responsive. Invalid regex patterns are reported in `result.error`.
 */
export function searchProject(
  sources: Iterable<[path: string, text: string]>,
  query: string,
  {
    matchCase = false,
    regex = false,
    limit = 1000,
    replacement,
  }: ProjectSearchOptions = {},
): ProjectSearchResult {
  const result: ProjectSearchResult = { files: [], total: 0, truncated: false };
  const compiled = compileSearchPattern(query, { matchCase, regex });
  if (!compiled) return result;
  if ("error" in compiled) return { ...result, error: compiled.error };
  const { pattern } = compiled;
  const sorted = [...sources].sort(([a], [b]) => a.localeCompare(b));
  for (const [path, text] of sorted) {
    const matches: ProjectSearchMatch[] = [];
    for (const { line, offset, content } of eachLine(text)) {
      for (const found of content.matchAll(pattern)) {
        const fromInLine = found.index;
        const matched = found[0];
        const length = matched.length;
        if (result.total === limit) {
          result.truncated = true;
          if (matches.length) result.files.push({ path, matches });
          return result;
        }
        const sliceStart = Math.max(0, fromInLine - previewContext);
        const sliceEnd = Math.min(
          content.length,
          fromInLine + length + previewContext,
        );
        const prefix = sliceStart > 0 ? "…" : "";
        const matchEntry: ProjectSearchMatch = {
          path,
          line,
          column: fromInLine + 1,
          from: offset + fromInLine,
          to: offset + fromInLine + length,
          match: matched,
          preview: `${prefix}${content.slice(sliceStart, sliceEnd)}${sliceEnd < content.length ? "…" : ""}`,
          start: prefix.length + fromInLine - sliceStart,
          end: prefix.length + fromInLine - sliceStart + length,
        };
        if (replacement !== undefined) {
          matchEntry.replacement = resolveReplacement(
            replacement,
            found,
            content,
            regex,
          );
        }
        matches.push(matchEntry);
        result.total++;
      }
    }
    if (matches.length) result.files.push({ path, matches });
  }
  return result;
}

/**
 * Computes all non-overlapping replacement edits for `query` in `text`.
 * Invalid regex patterns return `{ edits: [], error }` without modifying text.
 */
export function planTextReplacements(
  text: string,
  query: string,
  replacement: string,
  {
    matchCase = false,
    regex = false,
  }: { matchCase?: boolean; regex?: boolean } = {},
): { edits: ProjectSearchEdit[]; error?: string } {
  const compiled = compileSearchPattern(query, { matchCase, regex });
  if (!compiled) return { edits: [] };
  if ("error" in compiled) return { edits: [], error: compiled.error };
  const { pattern } = compiled;
  const edits: ProjectSearchEdit[] = [];
  for (const { offset, content } of eachLine(text)) {
    for (const found of content.matchAll(pattern)) {
      const from = offset + found.index;
      const to = from + found[0].length;
      edits.push({
        from,
        to,
        insert: resolveReplacement(replacement, found, content, regex),
      });
    }
  }
  return { edits };
}

/**
 * Builds a single-match edit only when the target range still holds the
 * expected matched text, preventing stale offsets from corrupting live edits.
 */
export function planSingleReplacement(
  text: string,
  match: Pick<ProjectSearchMatch, "from" | "to" | "match">,
  replacement: string,
): ProjectSearchEdit | null {
  if (match.from < 0 || match.to < match.from || match.to > text.length)
    return null;
  if (text.slice(match.from, match.to) !== match.match) return null;
  return { from: match.from, to: match.to, insert: replacement };
}

/** Applies non-overlapping UTF-16 range edits to `text`. */
export function applyTextEdits(
  text: string,
  edits: readonly ProjectSearchEdit[],
) {
  if (!edits.length) return text;
  let next = text;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to);
  }
  return next;
}
