// Copies the bundled Hunspell dictionaries into public/dictionaries, where the
// spelling worker fetches them on demand. Run before dev and build.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dictionaryPath,
  spellingDictionaries,
  type SpellingDictionary,
} from "#/lib/editor/spelling/languages";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public");
await mkdir(join(target, "dictionaries"), { recursive: true });

for (const [language, { package: name }] of Object.entries(
  spellingDictionaries,
) as [SpellingDictionary, { package: string }][]) {
  const source = dirname(fileURLToPath(import.meta.resolve(name)));
  for (const file of ["aff", "dic"] as const)
    await copyFile(
      join(source, `index.${file}`),
      join(target, dictionaryPath(language, file)),
    );
}
