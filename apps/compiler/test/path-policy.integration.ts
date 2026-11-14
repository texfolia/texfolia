import assert from "node:assert/strict";

import { parseProject } from "../src/project";

const engineUrl = process.env.ENGINE_URL;
assert(engineUrl, "Set ENGINE_URL to a local Tectonic engine");
const source = String.raw`\documentclass{article}\begin{document}Source path boundary check\end{document}`;
async function compile(input: ReturnType<typeof parseProject>) {
  return fetch(new URL("/compile", engineUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Compilation-Id": crypto.randomUUID(),
    },
    body: JSON.stringify(input),
  });
}
const paths = [
  "a".repeat(240),
  "é".repeat(120),
  "🦉".repeat(60),
  "sections/日本語.tex",
  "chapters/out/notes.tex",
  `folder/${"b".repeat(233)}`,
];
const project = parseProject({
  files: {
    "main.tex": source,
    ...Object.fromEntries(paths.map((path) => [path, "unreferenced source"])),
  },
});
const response = await compile(project);
assert(response.ok, await response.clone().text());
assert((await response.formData()).get("pdf") instanceof Blob);
for (const mainFile of [`${"a".repeat(236)}.tex`, `${"é".repeat(118)}.tex`]) {
  const response = await compile(
    parseProject({ mainFile, files: { [mainFile]: source } }),
  );
  assert(response.ok, await response.clone().text());
  const form = await response.formData();
  assert(form.get("pdf") instanceof Blob);
  assert(
    form.get(`artifact:${mainFile.slice(0, -4)}.synctex.gz`) instanceof Blob,
  );
}
for (const path of [
  "chapter:1.tex",
  "a".repeat(241),
  "é".repeat(121),
  "OUT/no.tex",
  `folder/${"b".repeat(234)}`,
]) {
  const input = {
    mainFile: "main.tex",
    files: { "main.tex": source, [path]: "bad" },
  };
  assert.throws(() => parseProject(input));
  // Bypass the API parser to verify the engine enforces the same rejection.
  assert.equal((await compile(input)).status, 400);
}
console.info(
  "Path policy passed with real Tectonic: nested and Unicode sources, maximum source and main filenames, generated SyncTeX artifacts, and rejected invalid paths.",
);
