import { expect, test } from "bun:test";

const root = new URL("./", import.meta.url);
const uiFile = (name: string) =>
  new URL(`../../../packages/ui/src/${name}.tsx`, root);

async function matches(url: URL, pattern: RegExp) {
  const text = await Bun.file(url).text();
  return [...text.matchAll(pattern)].flatMap(([, name]) => name ?? []);
}

test("Tailwind scans every @texfolia/ui component the site uses, and no other", async () => {
  const used = new Set<string>();
  const pending: string[] = [];
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(root.pathname))
    if (!file.endsWith(".test.ts"))
      pending.push(
        ...(await matches(new URL(file, root), /"@texfolia\/ui\/([a-z-]+)"/g)),
      );
  // Components also render each other.
  for (let name = pending.pop(); name; name = pending.pop()) {
    if (used.has(name)) continue;
    used.add(name);
    pending.push(...(await matches(uiFile(name), /"\.\/([a-z-]+)\.tsx"/g)));
  }
  const sources = await matches(
    new URL("styles.css", root),
    /@source "(.+)";/g,
  );
  expect(sources.sort()).toEqual(
    [...used].map((name) => `../../../packages/ui/src/${name}.tsx`).sort(),
  );
});
