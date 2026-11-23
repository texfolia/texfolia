export type ProjectSearchMatch = {
  path: string;
  line: number;
  column: number;
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
};

const previewContext = 40;

/**
 * Finds literal occurrences of `query` in project text files. Matches do not
 * span lines, and `limit` caps the total so a short query stays responsive.
 */
export function searchProject(
  sources: Iterable<[path: string, text: string]>,
  query: string,
  {
    matchCase = false,
    limit = 1000,
  }: { matchCase?: boolean; limit?: number } = {},
): ProjectSearchResult {
  const result: ProjectSearchResult = { files: [], total: 0, truncated: false };
  if (!query || query.includes("\n")) return result;
  // An escaped literal keeps case-insensitive offsets aligned with the source.
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    matchCase ? "g" : "gi",
  );
  const sorted = [...sources].sort(([a], [b]) => a.localeCompare(b));
  for (const [path, text] of sorted) {
    const matches: ProjectSearchMatch[] = [];
    const lines = text.split(/\r?\n|\r/);
    for (const [index, content] of lines.entries()) {
      for (const found of content.matchAll(pattern)) {
        const from = found.index;
        const length = found[0].length;
        if (result.total === limit) {
          result.truncated = true;
          if (matches.length) result.files.push({ path, matches });
          return result;
        }
        const sliceStart = Math.max(0, from - previewContext);
        const sliceEnd = Math.min(
          content.length,
          from + length + previewContext,
        );
        const prefix = sliceStart > 0 ? "…" : "";
        matches.push({
          path,
          line: index + 1,
          column: from + 1,
          preview: `${prefix}${content.slice(sliceStart, sliceEnd)}${sliceEnd < content.length ? "…" : ""}`,
          start: prefix.length + from - sliceStart,
          end: prefix.length + from - sliceStart + length,
        });
        result.total++;
      }
    }
    if (matches.length) result.files.push({ path, matches });
  }
  return result;
}
