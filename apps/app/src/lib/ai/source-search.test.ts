import { expect, test } from "bun:test";

import { readConcurrency, searchSources } from "./source-search";

function project(
  files: Record<string, string>,
  sizes = new Map<string, number>(),
) {
  let active = 0;
  const stats = { peak: 0, reads: [] as string[] };
  return {
    stats,
    files: Object.entries(files).map(([path, text]) => ({
      path,
      sizeBytes: BigInt(sizes.get(path) ?? text.length),
    })),
    read: async ({ path }: { path: string }) => {
      stats.reads.push(path);
      stats.peak = Math.max(stats.peak, ++active);
      await Bun.sleep(1);
      active--;
      return files[path] ?? "";
    },
  };
}

test("reads a few files at a time and returns matches in path order", async () => {
  const { stats, ...sources } = project(
    Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `${String(i).padStart(2, "0")}.tex`,
        i % 20 ? "nothing" : "Needle\nand needle",
      ]),
    ),
  );
  const result = await searchSources({ ...sources, query: "needle" });
  expect(result.matches.map(({ path, line }) => `${path}:${line}`)).toEqual([
    "00.tex:1",
    "00.tex:2",
    "20.tex:1",
    "20.tex:2",
    "40.tex:1",
    "40.tex:2",
  ]);
  expect(result).toMatchObject({ total: 6, truncated: false, skippedCount: 0 });
  expect(stats.peak).toBeLessThanOrEqual(readConcurrency);
});

test("stops reading once it has more matches than it returns", async () => {
  const { stats, ...sources } = project(
    Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `${String(i).padStart(3, "0")}.tex`,
        "x\n".repeat(50),
      ]),
    ),
  );
  const result = await searchSources({ ...sources, query: "x" });
  expect(result.matches).toHaveLength(200);
  expect(result.truncated).toBe(true);
  expect(stats.reads).toHaveLength(readConcurrency);
});

test("is not truncated at exactly the limit", async () => {
  const { stats: _stats, ...sources } = project({ "a.tex": "x\n".repeat(200) });
  expect(await searchSources({ ...sources, query: "x" })).toMatchObject({
    total: 200,
    truncated: false,
  });
});

test("skips files over 1 MiB, and those past 16 MiB in total", async () => {
  const names = Array.from({ length: 80 }, (_, i) => `${i}.tex`);
  const { stats, ...sources } = project(
    Object.fromEntries(names.map((name) => [name, ""])),
    new Map(names.map((name) => [name, 1024 * 1024])),
  );
  sources.files.push({ path: "big.tex", sizeBytes: 1024n * 1024n + 1n });
  const result = await searchSources({ ...sources, query: "x" });
  expect(stats.reads).toHaveLength(16);
  expect(result.skippedCount).toBe(65);
  expect(result.skipped).toHaveLength(50);
});
