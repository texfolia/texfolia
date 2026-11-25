import { expect, test } from "bun:test";

import { latexToolsVersion } from "./latex/tools";
import { spellingDictionaries } from "./spelling/languages";

async function installed(name: string) {
  const manifest = Bun.resolveSync(`${name}/package.json`, import.meta.dir);
  const { version } = (await Bun.file(manifest).json()) as { version: string };
  return version;
}

// Browsers keep these assets forever, so their URLs must change with them.
test("asset URLs carry the installed package versions", async () => {
  expect(latexToolsVersion).toBe(await installed("wasm-latex-tools"));
  for (const { package: name, version } of Object.values(spellingDictionaries))
    expect([name, version]).toEqual([name, await installed(name)]);
});
