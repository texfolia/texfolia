import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unknownEngineTiming } from "@texfolia/contracts";
import pathPolicy from "@texfolia/contracts/path-policy.json";

import { createBuildsRuntime } from "../../../test/builds/runtime";
import { coordinatorSnapshotSchema } from "./coordinator";
import {
  sourceDeltaSchema,
  sourceHash,
  sourceSnapshotSchema,
  type SourceDelta,
} from "./source-sync";
import type { Engine } from "./types";

const text = async (content: string) => ({
  hash: await sourceHash(new TextEncoder().encode(content)),
  content,
});

for (const fixture of pathPolicy)
  test(`source path policy: ${JSON.stringify(fixture.path)}`, () => {
    expect(
      sourceSnapshotSchema.safeParse({
        files: { "main.tex": "main", [fixture.path]: "source" },
      }).success,
    ).toBe(fixture.source);
  });

test("resync accepts an 8 MiB binary and rejects malformed base64", () => {
  const delta = {
    mainFile: "main.tex",
    baseRevision: 0,
    revision: 1,
    resync: true,
    files: {
      "main.tex": { hash: "0".repeat(64), content: "main" },
      "asset.bin": {
        hash: "1".repeat(64),
        content: { base64: Buffer.alloc(8 * 1024 * 1024).toString("base64") },
      },
    },
    deleted: [],
  };
  expect(sourceDeltaSchema.safeParse(delta).success).toBe(true);
  for (const base64 of ["A", "A===", "AA=A", "AA==\n", "!!!!", "AAAA===="])
    expect(
      sourceDeltaSchema.safeParse({
        ...delta,
        files: {
          ...delta.files,
          "asset.bin": { hash: "1".repeat(64), content: { base64 } },
        },
      }).success,
    ).toBe(false);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "source-sync-"));
  const options = {
    path: join(directory, "state.sqlite"),
    projectEngine: (): Engine => async (project, context) => {
      const sources: Record<string, string> = {};
      for (const [path, file] of Object.entries(project.files))
        sources[path] = Buffer.from(await context.readSource(file)).toString(
          "latin1",
        );
      built.push(sources);
      return {
        pdf: new TextEncoder().encode("%PDF-test"),
        log: "done",
        timing: unknownEngineTiming,
      };
    },
  };
  const projectId = crypto.randomUUID();
  const built: Record<string, string>[] = [];
  let runtime = createBuildsRuntime(options);
  const settle = async () => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const state = coordinatorSnapshotSchema.parse(
        await (
          await runtime.fetch(new Request(`http://local/projects/${projectId}`))
        ).json(),
      );
      if (
        state.current?.status === "succeeded" ||
        state.current?.status === "failed"
      )
        return state;
      await Bun.sleep(10);
    }
    throw new Error("Compile never completed");
  };
  return {
    projectId,
    built,
    settle,
    path: options.path,
    submit: (body: unknown, id = crypto.randomUUID()) =>
      runtime.fetch(
        new Request(`http://local/projects/${projectId}/compile`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Compilation-Id": id,
          },
          body: JSON.stringify(body),
        }),
      ),
    clear: () =>
      runtime.fetch(
        new Request(`http://local/projects/${projectId}/build`, {
          method: "DELETE",
        }),
      ),
    save: (key: string, bytes: Uint8Array) => runtime.save(key, bytes),
    drafts: () => runtime.drafts(projectId),
    async restart() {
      await runtime.close();
      runtime = createBuildsRuntime(options);
    },
    async close() {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const hashOf = async (content: string | Uint8Array<ArrayBuffer>) =>
  sourceHash(
    typeof content === "string" ? new TextEncoder().encode(content) : content,
  );

test("deltas compose debounced edits, survive restarts, and keep only referenced drafts", async () => {
  const f = await fixture();
  try {
    const initial: SourceDelta = {
      mainFile: "main.tex",
      baseRevision: 0,
      revision: 1,
      files: {
        "main.tex": await text("one"),
        "section.tex": await text("section"),
        "image.png": {
          hash: await hashOf(new Uint8Array([0, 1, 255])),
          content: { base64: "AAH/" },
        },
      },
      deleted: [],
    };
    expect((await f.submit(initial)).status).toBe(409);
    expect((await f.submit({ ...initial, resync: true })).status).toBe(202);
    await f.settle();
    expect(f.built[0]).toEqual({
      "main.tex": "one",
      "section.tex": "section",
      "image.png": "\u0000\u0001ÿ",
    });

    const changed = {
      mainFile: "main.tex",
      baseRevision: 1,
      revision: 2,
      files: { "main.tex": await text("two") },
      deleted: [],
    };
    const id = crypto.randomUUID();
    expect((await f.submit(changed, id)).status).toBe(202);
    expect((await f.submit(changed, id)).status).toBe(202);
    expect(
      (
        await f.submit(
          { ...changed, files: { "main.tex": await text("different") } },
          id,
        )
      ).status,
    ).toBe(409);
    await f.settle();
    expect(f.built[1]).toMatchObject({
      "main.tex": "two",
      "section.tex": "section",
    });

    expect(
      (
        await f.submit({
          ...changed,
          baseRevision: 2,
          revision: 3,
          files: { "main.tex": { hash: "0".repeat(64), content: "bad hash" } },
        })
      ).status,
    ).toBe(409);
    const queued = {
      ...changed,
      baseRevision: 2,
      revision: 3,
      files: { "main.tex": await text("three") },
    };
    expect((await f.submit(queued)).status).toBe(202);
    expect(
      (
        await f.submit({
          ...queued,
          baseRevision: 3,
          revision: 4,
          files: { "section.tex": await text("new section") },
        })
      ).status,
    ).toBe(202);
    await f.settle();
    expect(f.built).toHaveLength(3);
    expect(f.built[2]).toMatchObject({
      "main.tex": "three",
      "section.tex": "new section",
    });

    const inspect = new Database(f.path, { readonly: true });
    const saved = inspect
      .query<{ state: string }, []>("SELECT state FROM coordinators")
      .get()!.state;
    inspect.close();
    expect(saved).not.toContain('"content":');
    expect(saved).not.toContain('"base64":');
    const current = (
      await Promise.all([
        hashOf("three"),
        hashOf("new section"),
        hashOf(new Uint8Array([0, 1, 255])),
      ])
    ).sort();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && f.drafts().length !== 3)
      await Bun.sleep(25);
    expect(f.drafts()).toEqual(current);

    await f.restart();
    expect(
      (
        await f.submit({
          ...queued,
          baseRevision: 4,
          revision: 5,
          files: { "renamed.png": { hash: current.find(Boolean)! } },
          deleted: ["section.tex"],
        })
      ).status,
    ).toBe(202);
    await f.settle();
    expect(Object.keys(f.built[3]!).sort()).toEqual([
      "image.png",
      "main.tex",
      "renamed.png",
    ]);
    expect((await f.clear()).status).toBe(204);
    expect(f.drafts()).toEqual([]);
    expect(
      (await f.submit({ ...queued, baseRevision: 5, revision: 6, files: {} }))
        .status,
    ).toBe(409);
    expect((await f.submit({ ...initial, resync: true })).status).toBe(202);
    expect((await f.settle()).current?.sourceRevision).toBe(1);
  } finally {
    await f.close();
  }
});

test("saved sources are read from the app's bucket by hash and never copied", async () => {
  const f = await fixture();
  try {
    const image = new Uint8Array([1, 2, 3]);
    const imageHash = await hashOf(image);
    const delta: SourceDelta = {
      mainFile: "main.tex",
      baseRevision: 0,
      revision: 1,
      resync: true,
      files: {
        "main.tex": await text("draft"),
        "image.png": { hash: imageHash },
      },
      deleted: [],
    };
    // A hash nobody has saved needs a resync from the server's file table.
    expect((await f.submit(delta)).status).toBe(409);
    f.save(`projects/${f.projectId}/sources/${imageHash}`, image);
    expect((await f.submit(delta)).status).toBe(202);
    await f.settle();
    expect(f.built[0]).toEqual({
      "main.tex": "draft",
      "image.png": "\u0001\u0002\u0003",
    });
    expect(f.drafts()).toEqual([await hashOf("draft")]);

    // Server resyncs carry sizes, so a missing object surfaces at compile time.
    const gone = await hashOf("gone");
    expect(
      (
        await f.submit({
          ...delta,
          baseRevision: 1,
          revision: 2,
          files: {
            "main.tex": await text("draft"),
            "gone.tex": { hash: gone, size: 4 },
          },
        })
      ).status,
    ).toBe(202);
    const failed = await f.settle();
    expect(failed.current).toMatchObject({
      status: "failed",
      error: "Project sources changed while compiling. Compile again.",
    });
    // The broken manifest is dropped, so the next delta resyncs from zero.
    const retry = await f.submit({
      ...delta,
      baseRevision: 2,
      revision: 3,
      resync: false,
    });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({
      resync: true,
      sourceRevision: 0,
    });
  } finally {
    await f.close();
  }
});

test("snapshots compile inline content and saved objects by key", async () => {
  const f = await fixture();
  try {
    const key = "templates/example/sources/object";
    f.save(key, new TextEncoder().encode("saved"));
    expect(
      (
        await f.submit({
          files: {
            "main.tex": "inline",
            "asset.bin": { base64: "AAH/" },
            "saved.tex": { key, hash: await hashOf("saved"), size: 5 },
          },
        })
      ).status,
    ).toBe(202);
    const state = await f.settle();
    expect(state.current?.status).toBe("succeeded");
    expect(state.current?.sourceRevision).toBeUndefined();
    expect(f.built[0]).toEqual({
      "main.tex": "inline",
      "asset.bin": "\u0000\u0001ÿ",
      "saved.tex": "saved",
    });
    for (const files of [
      {},
      { "other.tex": "x" },
      { "main.tex": "x", "main.tex/child": "y" },
      { "main.tex": "x", "../escape": "y" },
      { "main.tex": "x", "out/stolen": "y" },
      Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [
          index ? `${index}.tex` : "main.tex",
          "x",
        ]),
      ),
    ])
      expect((await f.submit({ files })).status).toBe(400);
  } finally {
    await f.close();
  }
});

test("the total source quota applies across deltas without persisting rejected content", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.submit({
          mainFile: "main.tex",
          baseRevision: 0,
          revision: 1,
          resync: true,
          files: { "main.tex": await text("a".repeat(8 * 1024 * 1024)) },
          deleted: [],
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await f.submit({
          mainFile: "main.tex",
          baseRevision: 1,
          revision: 2,
          files: { "extra.tex": await text("b".repeat(2 * 1024 * 1024)) },
          deleted: [],
        })
      ).status,
    ).toBe(413);
    expect(f.drafts()).toHaveLength(1);
  } finally {
    await f.close();
  }
});
