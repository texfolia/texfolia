import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { convertV4MiniflareOptions, Miniflare } from "miniflare";

export async function migrateLocalSources(directory: string) {
  const marker = join(directory, "local-source-bucket-migrated");
  if (
    existsSync(marker) ||
    !existsSync(join(directory, "r2", "texfolia-sources"))
  )
    return;

  const runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response(null); } }",
      r2Buckets: {
        PREVIOUS: "texfolia-sources",
        SOURCES: "texfolia-sources-local",
      },
    }),
    resourcePersistencePath: directory,
  });
  try {
    const previous = await runtime.getR2Bucket("PREVIOUS");
    const sources = await runtime.getR2Bucket("SOURCES");
    let cursor: string | undefined;
    do {
      const page = await previous.list({ cursor });
      for (const item of page.objects) {
        if (await sources.head(item.key)) continue;
        const object = await previous.get(item.key);
        if (object)
          await sources.put(item.key, await object.arrayBuffer(), {
            httpMetadata: object.httpMetadata,
            customMetadata: object.customMetadata,
          });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await writeFile(
      marker,
      "Copied existing local sources without deleting the previous bucket.\n",
    );
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.main)
  await migrateLocalSources(
    fileURLToPath(new URL("../.wrangler/state/v3", import.meta.url)),
  );
