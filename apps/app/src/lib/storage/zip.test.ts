import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as referenceCrc32 } from "node:zlib";

import { crc32, createZip, zipStream } from "./zip";

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

test("archives past the 16-bit entry count use ZIP64", async () => {
  const count = 70_000;
  async function* entries() {
    for (let index = 0; index < count; index++)
      yield { path: `${index}`, open: async () => new Uint8Array() };
  }
  const archive = await new Response(zipStream(entries())).arrayBuffer();
  const root = await mkdtemp(join(tmpdir(), "account-export-"));
  try {
    const path = join(root, "account.zip");
    await writeFile(path, new Uint8Array(archive));
    const read = Bun.spawnSync([
      "python3",
      "-c",
      "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(len(z.namelist()), z.namelist()[-1])",
      path,
    ]);
    expect(read.stdout.toString().trim()).toBe(`${count} ${count - 1}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checksums match zlib", () => {
  expect(crc32(new Uint8Array())).toBe(0);
  for (const size of [1, 3, 255, 4096, 65_536]) {
    const data = crypto.getRandomValues(new Uint8Array(size));
    expect(crc32(data)).toBe(referenceCrc32(data));
  }
});

test("entries are opened one at a time as the archive is read", async () => {
  const opened: number[] = [];
  const size = 100_000;
  const reader = zipStream(
    Array.from({ length: 50 }, (_, index) => ({
      path: `${index}.bin`,
      open: async () => {
        opened.push(index);
        return new Uint8Array(size);
      },
    })),
  ).getReader();
  let read = 0;
  while (read < size * 3) read += (await reader.read()).value!.byteLength;
  await Bun.sleep(5);
  expect(opened.length).toBeLessThanOrEqual(6);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
  }
  expect(opened).toHaveLength(50);
  expect(read).toBeGreaterThan(50 * size);
});

test("a source that cannot be opened fails the archive instead of shortening it", async () => {
  const archive = zipStream([
    { path: "a", open: async () => new Uint8Array(10) },
    {
      path: "b",
      open: async () => {
        throw new Error("missing");
      },
    },
  ]);
  await expect(new Response(archive).arrayBuffer()).rejects.toThrow();
});

test("cancelling an archive stops opening entries", async () => {
  let opened = 0;
  const archive = zipStream(
    Array.from({ length: 50 }, (_, index) => ({
      path: `${index}`,
      open: async () => {
        opened++;
        return new Uint8Array(10);
      },
    })),
  );
  const reader = archive.getReader();
  await reader.read();
  await reader.cancel();
  await Bun.sleep(5);
  expect(opened).toBeLessThan(10);
});
