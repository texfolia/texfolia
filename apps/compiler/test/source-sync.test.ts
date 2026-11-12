import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { coordinatorSnapshotSchema } from "../src/coordinator";
import { createEngineClient } from "../src/engine";
import type { Engine } from "../src/jobs";
import { createLocalRuntime } from "../src/local";
import {
  sourceDeltaSchema,
  sourceHash,
  type SourceDelta,
} from "../src/source-sync";

const text = async (content: string) => ({
  hash: await sourceHash(new TextEncoder().encode(content)),
  content,
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
const result = (revision: number) => {
  const form = new FormData();
  form.set("pdf", new Blob(["%PDF-test"]), "main.pdf");
  form.set("log", "done");
  return new Response(form, {
    headers: { "X-Source-Revision": String(revision) },
  });
};

test("delta submissions persist only changed objects, compose debounced edits, and recover across SQLite/container restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-sync-"));
  const path = join(directory, "state.sqlite");
  const projectId = crypto.randomUUID();
  const requests: SourceDelta[] = [];
  let restarted = false;
  let reads = 0;
  const engine = createEngineClient(async (request) => {
    const delta = sourceDeltaSchema.parse(await request.json());
    requests.push(delta);
    if (restarted) {
      restarted = false;
      return Response.json(
        { error: "Source resync required" },
        { status: 409, headers: { "X-Source-Resync": "1" } },
      );
    }
    return result(delta.revision);
  });
  const measuredEngine: Engine = (project, context) =>
    engine(project, {
      ...context,
      readSource: async (file) => {
        reads++;
        if (!context.readSource) throw new Error("Missing source reader");
        return context.readSource(file);
      },
    });
  const options = { path, engine, projectEngine: () => measuredEngine };
  let runtime = createLocalRuntime(options);
  const submit = (delta: SourceDelta, id = crypto.randomUUID()) =>
    runtime.fetch(
      new Request(`http://local/projects/${projectId}/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Compilation-Id": id },
        body: JSON.stringify(delta),
      }),
    );
  const settle = async () => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const response = await runtime.fetch(
        new Request(`http://local/projects/${projectId}`),
      );
      const state = coordinatorSnapshotSchema.parse(await response.json());
      if (state.current?.status === "succeeded") return state;
      if (state.current?.status === "failed")
        throw new Error(JSON.stringify(state));
      await Bun.sleep(10);
    }
    throw new Error("Compile never completed");
  };
  try {
    const initial: SourceDelta = {
      mainFile: "main.tex",
      baseRevision: 0,
      revision: 1,
      files: {
        "main.tex": await text("one"),
        "section.tex": await text("section"),
        "image.png": {
          hash: await sourceHash(new Uint8Array([0, 1, 255])),
          content: { base64: "AAH/" },
        },
      },
      deleted: [],
    };
    expect((await submit(initial)).status).toBe(409);
    const first = await submit({ ...initial, resync: true });
    expect(first.status).toBe(202);
    await settle();
    expect(requests[0]?.resync).toBe(true);
    expect(Object.keys(requests[0]!.files)).toHaveLength(3);

    const changed = {
      mainFile: "main.tex",
      baseRevision: 1,
      revision: 2,
      files: { "main.tex": await text("two") },
      deleted: [],
    };
    const id = crypto.randomUUID();
    expect((await submit(changed, id)).status).toBe(202);
    expect((await submit(changed, id)).status).toBe(202);
    expect(
      (
        await submit(
          { ...changed, files: { "main.tex": await text("different") } },
          id,
        )
      ).status,
    ).toBe(409);
    await settle();
    expect(Object.keys(requests[1]!.files)).toEqual(["main.tex"]);
    expect(requests[1]?.files["main.tex"]?.content).toBe("two");
    expect(requests[1]?.resync).toBeUndefined();
    expect(reads).toBe(4);

    expect(
      (
        await submit({
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
    expect((await submit(queued)).status).toBe(202);
    expect(
      (
        await submit({
          ...queued,
          baseRevision: 3,
          revision: 4,
          files: { "section.tex": await text("new section") },
        })
      ).status,
    ).toBe(202);
    await settle();
    expect(Object.keys(requests[2]!.files).sort()).toEqual([
      "main.tex",
      "section.tex",
    ]);
    expect(requests[2]?.baseRevision).toBe(2);
    expect(requests[2]?.revision).toBe(4);
    expect(reads).toBe(6);

    const inspect = new Database(path, { readonly: true });
    const saved = inspect
      .query<{ state: string }, []>("SELECT state FROM coordinators")
      .get()!.state;
    expect(saved).not.toContain('"content":');
    expect(saved).not.toContain('"base64":');
    const objects = inspect
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM objects WHERE key LIKE '%/source-objects/%'",
      )
      .get()!.count;
    expect(objects).toBe(3);
    inspect.close();

    await runtime.close();
    runtime = createLocalRuntime(options);
    restarted = true;
    expect(
      (
        await submit({
          ...queued,
          baseRevision: 4,
          revision: 5,
          files: {},
          deleted: ["section.tex"],
        })
      ).status,
    ).toBe(202);
    await settle();
    expect(requests[3]?.deleted).toEqual(["section.tex"]);
    expect(requests[4]?.resync).toBe(true);
    expect(Object.keys(requests[4]!.files).sort()).toEqual([
      "image.png",
      "main.tex",
    ]);
    expect(requests[4]?.files["image.png"]?.content).toEqual({
      base64: "AAH/",
    });
    expect(reads).toBe(8);
    expect(
      (
        await runtime.fetch(
          new Request(`http://local/projects/${projectId}/build`, {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(204);
    expect(
      (await submit({ ...queued, baseRevision: 5, revision: 6, files: {} }))
        .status,
    ).toBe(409);
    expect((await submit({ ...initial, resync: true })).status).toBe(202);
    const reset = await settle();
    expect(reset.current?.sourceRevision).toBe(1);
    expect(requests.at(-1)?.resync).toBe(true);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("engine clean retries reuse the same source revision and binary renames reuse hashes", async () => {
  const bodies: SourceDelta[] = [];
  let sourceReads = 0;
  const engine = createEngineClient(async (request) => {
    const body = z.object(sourceDeltaSchema.shape).parse(await request.json());
    bodies.push(body);
    return result(body.revision);
  });
  const main = await text("hello");
  const binary = await text("binary");
  const files = {
    "main.tex": { hash: main.hash, encoding: "text" as const, size: 5 },
    "old.png": { hash: binary.hash, encoding: "base64" as const, size: 6 },
  };
  const project = {
    kind: "synced" as const,
    mainFile: "main.tex",
    revision: 1,
    files,
  };
  const context = {
    jobId: crypto.randomUUID(),
    plan: "free" as const,
    attempt: 1,
    readSource: async (file: { hash: string }) => {
      sourceReads++;
      return file.hash === main.hash ? "hello" : { base64: btoa("binary") };
    },
  };
  await engine(project, context);
  await engine(project, context);
  expect(bodies[1]).toMatchObject({
    baseRevision: 1,
    revision: 1,
    files: {},
    deleted: [],
  });
  await engine(
    {
      ...project,
      revision: 2,
      files: { "main.tex": files["main.tex"], "new.png": files["old.png"] },
    },
    context,
  );
  expect(bodies[2]?.files).toEqual({ "new.png": { hash: binary.hash } });
  expect(bodies[2]?.deleted).toEqual(["old.png"]);
  expect(sourceReads).toBe(2);
  await engine(project, context);
  expect(bodies[3]?.resync).toBe(true);
  expect(bodies[3]?.baseRevision).toBe(0);
  expect(bodies[3]?.revision).toBe(1);
});

test("the total source quota applies across deltas without persisting rejected content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-sync-quota-"));
  const path = join(directory, "state.sqlite");
  const projectId = crypto.randomUUID();
  const engine = createEngineClient(async () => result(1));
  const runtime = createLocalRuntime({
    path,
    engine,
    projectEngine: () => engine,
  });
  const submit = (delta: SourceDelta) =>
    runtime.fetch(
      new Request(`http://local/projects/${projectId}/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delta),
      }),
    );
  try {
    expect(
      (
        await submit({
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
        await submit({
          mainFile: "main.tex",
          baseRevision: 1,
          revision: 2,
          files: { "extra.tex": await text("b".repeat(2 * 1024 * 1024)) },
          deleted: [],
        })
      ).status,
    ).toBe(413);
    const database = new Database(path, { readonly: true });
    try {
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM objects WHERE key LIKE '%/source-objects/%'",
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
