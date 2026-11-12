import { expect, test } from "bun:test";

import { hashSource, ProjectSourceSync } from "./source-sync";

test("recompiles send changed content, hashes for binary references, and deletions", async () => {
  const sync = new ProjectSourceSync();
  const binary = { hash: await hashSource(new Uint8Array([0, 1, 255])) };
  const first = await sync.prepare("main.tex", {
    "main.tex": "one",
    "section.tex": "unchanged",
    "image.png": binary,
  });
  expect(first.delta).toMatchObject({
    baseRevision: 0,
    revision: 1,
    deleted: [],
  });
  expect(first.delta.files["main.tex"]?.content).toBe("one");
  expect(first.delta.files["image.png"]).toEqual(binary);
  sync.accept(7, first.hashes, first.sequence);

  const second = await sync.prepare("main.tex", {
    "main.tex": "two",
    "section.tex": "unchanged",
    "image.png": binary,
  });
  expect(second.delta).toEqual({
    mainFile: "main.tex",
    baseRevision: 7,
    revision: 8,
    files: {
      "main.tex": {
        hash: await hashSource(new TextEncoder().encode("two")),
        content: "two",
      },
    },
    deleted: [],
  });
  sync.accept(8, second.hashes, second.sequence);
  const deleted = await sync.prepare("main.tex", {
    "main.tex": "two",
    "image.png": binary,
  });
  expect(deleted.delta.files).toEqual({});
  expect(deleted.delta.deleted).toEqual(["section.tex"]);
});

test("unacknowledged and out-of-order submissions never advance the browser base", async () => {
  const sync = new ProjectSourceSync();
  await sync.prepare("main.tex", { "main.tex": "lost request" });
  const retry = await sync.prepare("main.tex", { "main.tex": "newest" });
  expect(retry.delta.baseRevision).toBe(0);
  sync.accept(3, retry.hashes, retry.sequence);
  sync.accept(2, new Map([["main.tex", "stale"]]), retry.sequence - 1);
  const next = await sync.prepare("main.tex", { "main.tex": "newest" });
  expect(next.delta).toMatchObject({ baseRevision: 3, revision: 4, files: {} });
});

test("a compile hashes against one acknowledged base even if another submission completes mid-hash", async () => {
  const sync = new ProjectSourceSync();
  const hash = await hashSource(new TextEncoder().encode("in flight"));
  const prepared = sync.prepare("main.tex", { "main.tex": "in flight" });
  sync.accept(2, new Map([["main.tex", hash]]), 2);
  const result = await prepared;
  expect(result.delta.baseRevision).toBe(0);
  expect(result.delta.revision).toBe(1);
  expect(result.delta.files["main.tex"]?.content).toBe("in flight");
});

test("a full resync can reset the revision after coordinator state is cleared", async () => {
  const sync = new ProjectSourceSync();
  const initial = await sync.prepare("main.tex", { "main.tex": "saved" });
  sync.accept(9, initial.hashes, initial.sequence);
  const resync = await sync.prepare("main.tex", { "main.tex": "saved" });
  sync.accept(1, resync.hashes, resync.sequence);
  expect(
    (await sync.prepare("main.tex", { "main.tex": "saved" })).delta
      .baseRevision,
  ).toBe(1);
});
