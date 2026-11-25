import { searchProject, type ProjectSearchMatch } from "#/lib/projects";

/** How many files one tool call reads at once. Each stays below 1 MiB. */
export const readConcurrency = 6;
const maxSearchFileBytes = 1024 * 1024;
const maxSearchBytes = 16 * 1024 * 1024;
const maxMatches = 200;
const maxSkippedPaths = 50;

/**
 * Searches files a few at a time and keeps only their matches, so a search
 * holds a few files in memory however large the project is.
 */
export async function searchSources<
  T extends { path: string; sizeBytes: bigint },
>({
  files,
  read,
  query,
  matchCase,
}: {
  files: readonly T[];
  read: (file: T) => Promise<string>;
  query: string;
  matchCase?: boolean;
}) {
  const skipped: string[] = [];
  const scanned: T[] = [];
  let bytes = 0;
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const size = Number(file.sizeBytes);
    if (size > maxSearchFileBytes || bytes + size > maxSearchBytes) {
      skipped.push(file.path);
      continue;
    }
    bytes += size;
    scanned.push(file);
  }
  const matches: ProjectSearchMatch[] = [];
  for (
    let start = 0;
    start < scanned.length && matches.length <= maxMatches;
    start += readConcurrency
  ) {
    const found = await Promise.all(
      scanned.slice(start, start + readConcurrency).map(async (file) =>
        // One more than is returned shows that there are more.
        searchProject([[file.path, await read(file)]], query, {
          matchCase,
          limit: maxMatches + 1,
        }).files.flatMap((result) => result.matches),
      ),
    );
    for (const fileMatches of found) matches.push(...fileMatches);
  }
  const returned = matches.slice(0, maxMatches);
  return {
    matches: returned.map(({ path, line, column, preview }) => ({
      path,
      line,
      column,
      preview,
    })),
    total: returned.length,
    truncated: matches.length > maxMatches,
    /** Files too large to search, or past the total one search reads. */
    skipped: skipped.slice(0, maxSkippedPaths),
    skippedCount: skipped.length,
  };
}
