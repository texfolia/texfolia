import assert from "node:assert/strict";

import { compileOnEngine, compileSuccessfully } from "../scripts/engine-client";

const engineUrl = process.env.ENGINE_URL;
assert(engineUrl, "Set ENGINE_URL to a local Tectonic engine");
const source = String.raw`\documentclass{article}\begin{document}Source path boundary check\end{document}`;
const paths = [
  "a".repeat(240),
  "é".repeat(120),
  "🦉".repeat(60),
  "sections/日本語.tex",
  "chapters/out/notes.tex",
  `folder/${"b".repeat(233)}`,
];
await compileSuccessfully({
  files: {
    "main.tex": source,
    ...Object.fromEntries(paths.map((path) => [path, "unreferenced source"])),
  },
});
for (const mainFile of [`${"a".repeat(236)}.tex`, `${"é".repeat(118)}.tex`]) {
  const output = await compileSuccessfully({
    mainFile,
    files: { [mainFile]: source },
  });
  assert(output.files.has(`${mainFile.slice(0, -4)}.synctex.gz`));
}
for (const path of [
  "chapter:1.tex",
  "a".repeat(241),
  "é".repeat(121),
  "OUT/no.tex",
  `folder/${"b".repeat(234)}`,
])
  await assert.rejects(
    compileOnEngine({ files: { "main.tex": source, [path]: "bad" } }),
    /Engine returned 400/,
  );
console.info(
  "Path policy passed with real Tectonic: nested and Unicode sources, maximum source and main filenames, generated SyncTeX artifacts, and rejected invalid paths.",
);
