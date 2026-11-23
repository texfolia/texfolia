import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createZip } from "./zip";

test("standard ZIP readers recover Unicode paths and binary build files without changing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-export-"));
  try {
    const path = join(root, "project.zip");
    const archive = await createZip([
      { path: "chapters/é.tex", blob: new Blob(["\\section{Hello}"]) },
      {
        path: "out/custom.bin",
        blob: new Blob([new Uint8Array([0, 1, 2, 255])]),
      },
    ]);
    await writeFile(path, new Uint8Array(await archive.arrayBuffer()));
    const check = Bun.spawnSync(["unzip", "-t", path]);
    expect(check.exitCode).toBe(0);
    const read = Bun.spawnSync([
      "python3",
      "-c",
      "import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({name: list(z.read(name)) for name in z.namelist()}))",
      path,
    ]);
    expect(read.exitCode).toBe(0);
    const contents = JSON.parse(new TextDecoder().decode(read.stdout));
    expect(
      new TextDecoder().decode(new Uint8Array(contents["chapters/é.tex"])),
    ).toBe("\\section{Hello}");
    expect(contents["out/custom.bin"]).toEqual([0, 1, 2, 255]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
