import type { ArtifactManifest } from "@texfolia/contracts";

import { mapLimit } from "#/lib/map-limit";

import type { Engine, ObjectStore } from "./types";

// R2 allows six simultaneous connections per request.
export const storageConcurrency = 6;

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
    [pdf]: output.pdf,
    [`${name}.log`]: new TextEncoder().encode(output.log),
  };
  if (!data[pdf]) throw new Error("Build has no PDF artifact");
  const generation = crypto.randomUUID();
  const files = await mapLimit(
    Object.entries(data),
    storageConcurrency,
    async ([path, bytes]) => {
      const key = `projects/${projectId}/builds/${generation}/${path}`;
      if (!(await store.create(key, bytes)))
        throw new Error("Build artifact was not saved");
      return { path, key, sizeBytes: bytes.byteLength };
    },
  );
  return {
    ...build,
    builtAt: new Date().toISOString(),
    engine: output.timing.engine,
    pdf,
    files,
  };
}
