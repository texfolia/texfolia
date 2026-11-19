import { z } from "zod";

import { artifactPathSchema } from "./project";
import type { Engine, ObjectStore } from "./types";

export const artifactManifestSchema = z.object({
  id: z.string(),
  revision: z.number(),
  digest: z.string(),
  builtAt: z.string(),
  builtBy: z.string(),
  engine: z.string(),
  pdf: artifactPathSchema.nullable(),
  files: z.array(
    z.object({
      path: artifactPathSchema,
      key: z.string(),
      sizeBytes: z.number(),
    }),
  ),
});
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

export function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export const decodeBase64 = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export async function storeArtifacts(options: {
  store: ObjectStore;
  projectId: string;
  mainFile: string;
  build: Pick<ArtifactManifest, "id" | "revision" | "digest" | "builtBy">;
  output: Awaited<ReturnType<Engine>>;
}): Promise<ArtifactManifest> {
  const { store, projectId, mainFile, build, output } = options;
  const name = mainFile
    .split("/")
    .at(-1)!
    .replace(/\.tex$/, "");
  const pdf = `${name}.pdf`;
  const data = output.files ?? {
    [pdf]: new Blob([new Uint8Array(output.pdf)]),
    [`${name}.log`]: new Blob([output.log]),
  };
  if (!data[pdf]) throw new Error("Build has no PDF artifact");
  const files: ArtifactManifest["files"] = [];
  const generation = crypto.randomUUID();
  for (const [path, value] of Object.entries(data)) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    const key = `projects/${projectId}/builds/${generation}/${path}`;
    if (!(await store.create(key, bytes)))
      throw new Error("Build artifact was not saved");
    files.push({ path, key, sizeBytes: bytes.byteLength });
  }
  return {
    ...build,
    builtAt: new Date().toISOString(),
    engine: output.timing.engine,
    pdf,
    files,
  };
}
