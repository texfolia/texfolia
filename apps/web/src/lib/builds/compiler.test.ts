import { expect, test } from "bun:test";

import {
  createCompilerFixture,
  fixtureResponse,
  type FixtureOutput,
  type FixtureRequest,
} from "../../../test/builds/compiler-fixture";
import { collectSinks } from "../../../test/builds/engine";
import { memoryStore, type StoredObject } from "../../../test/builds/stores";
import { createCompilerEngine } from "./compiler";
import { EngineError, HttpError, MissingSourceError } from "./project";
import { sourceHash, type SyncedProject } from "./source-sync";
import type { Engine } from "./types";

const bytes = (text: string) => new TextEncoder().encode(text);
const projectId = crypto.randomUUID();
const key = `projects/${projectId}/cache.tar.zst`;

async function project(
  files: Record<string, string>,
  options: Partial<SyncedProject> = {},
) {
  const contents = new Map<string, Uint8Array<ArrayBuffer>>();
  const synced: SyncedProject = {
    mainFile: "main.tex",
    revision: 1,
    files: {},
    ...options,
  };
  for (const [path, text] of Object.entries(files)) {
    const hash = await sourceHash(bytes(text));
    contents.set(hash, bytes(text));
    synced.files[path] = { hash, size: bytes(text).length };
  }
  return { synced, contents };
}

function harness(
  compile: (
    request: FixtureRequest,
  ) => FixtureOutput | Response | Promise<FixtureOutput | Response> = () => ({
    pdf: "%PDF",
    log: "ok",
  }),
) {
  const compiler = createCompilerFixture(compile);
  const objects = new Map<string, StoredObject>();
  const pauses: number[] = [];
  const reads: string[] = [];
  const engine = createCompilerEngine({
    projectId,
    store: memoryStore(objects),
    cacheKey: key,
    fetch: (path, init) => compiler.fetch(path, init),
    pause: async (ms) => void pauses.push(ms),
  });
  const run = async (
    files: Record<string, string>,
    options: Partial<Parameters<Engine>[1]> & {
      project?: Partial<SyncedProject>;
    } = {},
  ) => {
    const { project: change, ...context } = options;
    const { synced, contents } = await project(files, change);
    const collected = collectSinks();
    const output = await engine(synced, {
      jobId: crypto.randomUUID(),
      plan: "free",
      attempt: 1,
      readSource: async (file) => {
        reads.push(file.hash);
        return contents.get(file.hash)!;
      },
      artifacts: collected.sinks,
      ...context,
    });
    return { ...output, ...collected };
  };
  return { compiler, objects, pauses, reads, engine, run };
}

const hashes = (...texts: string[]) =>
  Promise.all(texts.map((text) => sourceHash(bytes(text))));

test("the first build sends everything; later builds send only what the container lacks", async () => {
  const { compiler, run, reads } = harness(({ sources }) => ({
    pdf: `%PDF-${new TextDecoder().decode(sources["main.tex"])}`,
    log: "ok",
  }));
  await run({ "main.tex": "one", "a.tex": "a", "image.png": "binary" });
  expect(compiler.requests[0]).toMatchObject({
    options: { affinity: projectId, timeoutMs: 15_000, priority: 0 },
    manifest: { mainFile: "main.tex" },
  });
  expect(compiler.requests[0]?.options.container).toBeUndefined();
  expect(compiler.requests[0]?.received.sort()).toEqual(
    (await hashes("one", "a", "binary")).sort(),
  );
  reads.length = 0;
  const second = await run({
    "main.tex": "two",
    "a.tex": "a",
    "renamed.png": "binary",
  });
  expect(second.text("pdf")).toBe("%PDF-two");
  expect(compiler.requests[1]).toMatchObject({
    options: { container: "compiler-1" },
    manifest: { incremental: true },
    received: await hashes("two"),
  });
  expect(reads).toEqual(await hashes("two"));
  // A clean retry of the same revision sends no sources at all.
  await run(
    { "main.tex": "two", "a.tex": "a", "renamed.png": "binary" },
    { clean: true },
  );
  expect(compiler.requests[2]).toMatchObject({
    manifest: { incremental: true, clean: true },
    received: [],
  });
});

test("a replaced container gets one full retry with the cache archive", async () => {
  const { compiler, objects, run } = harness(({ cache }) => ({
    pdf: "%PDF",
    log: cache ? new TextDecoder().decode(cache) : "no cache",
    timing: {
      engine: "tectonic",
      temperature: "warm",
      inputPrepMs: 1,
      compileMs: 1,
      outputMs: 1,
      archiveStatus: "restored",
    },
  }));
  objects.set(key, { bytes: bytes("archive"), uploaded: 0 });
  const first = await run({ "main.tex": "one" });
  expect(first.log).toBe("archive");
  expect(first.timing).toMatchObject({
    containerStartMs: 1,
    prewarmed: true,
    archiveStatus: "restored",
  });
  expect(first.timing.archiveFetchMs).toBeNumber();
  expect((await run({ "main.tex": "two" })).log).toBe("no cache");
  compiler.restart();
  expect((await run({ "main.tex": "three" })).log).toBe("archive");
  expect(compiler.requests.map(({ options }) => options.container)).toEqual([
    undefined,
    "compiler-1",
    undefined,
  ]);
});

test("clean builds and unavailable or oversized archives compile without a cache", async () => {
  const { objects, run, compiler } = harness(({ cache }) => ({
    pdf: "%PDF",
    log: cache ? "cache" : "none",
  }));
  objects.set(key, { bytes: bytes("archive"), uploaded: 0 });
  expect((await run({ "main.tex": "x" }, { clean: true })).log).toBe("none");
  compiler.restart();
  objects.set(key, {
    bytes: new Uint8Array(33 * 1024 * 1024 + 1),
    uploaded: 0,
  });
  expect((await run({ "main.tex": "x" })).log).toBe("none");
  const failing = createCompilerEngine({
    projectId,
    store: {
      open: async () => {
        throw new Error("R2 unavailable");
      },
    },
    cacheKey: key,
    fetch: (path, init) =>
      createCompilerFixture(() => ({ pdf: "%PDF" })).fetch(path, init),
  });
  const { synced, contents } = await project({ "main.tex": "x" });
  const output = await failing(synced, {
    jobId: "job",
    plan: "pro",
    attempt: 1,
    readSource: async (file) => contents.get(file.hash)!,
    artifacts: collectSinks().sinks,
  });
  expect(output.timing.archiveStatus).toBe("unavailable");
});

test("plans choose the timeout, queue priority, and Free yield; fair use can shorten the timeout", async () => {
  const { compiler, pauses, run } = harness();
  await run({ "main.tex": "x" }, { plan: "pro" });
  await run({ "main.tex": "x" }, { plan: "team", timeoutMs: 42_000 });
  expect(pauses).toEqual([]);
  await run({ "main.tex": "x" }, { plan: "free", timeoutMs: 999_999 });
  await run({ "main.tex": "x" }, { plan: "unknown" });
  expect(pauses).toEqual([25, 25]);
  expect(
    compiler.requests.map(({ options }) => [
      options.timeoutMs,
      options.priority,
    ]),
  ).toEqual([
    [300_000, 1],
    [42_000, 1],
    [15_000, 0],
    [15_000, 0],
  ]);
});

test("artifacts and the cache archive are streamed by path", async () => {
  const { run } = harness(() => ({
    pdf: "%PDF",
    log: "summary",
    files: { "main.aux": "aux", "nested/data.bin": new Uint8Array([0, 255]) },
    cache: "archive",
  }));
  const output = await run({ "main.tex": "x" });
  expect([...output.entries.keys()]).toEqual([
    "pdf",
    "file:main.aux",
    "file:nested/data.bin",
    "cache",
  ]);
  expect(output.entries.get("file:nested/data.bin")).toEqual(
    new Uint8Array([0, 255]),
  );
  expect(output.text("cache")).toBe("archive");
  expect(output.sizeBytes).toBe(4);
});

test("previews are opt-in, and a missing or oversized image is an infrastructure failure", async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const images: (Uint8Array | undefined)[] = [
    undefined,
    png,
    undefined,
    new Uint8Array(4 * 1024 * 1024 + 1),
  ];
  const { compiler, run } = harness(() => ({
    pdf: "%PDF",
    preview: images.shift(),
  }));
  expect((await run({ "main.tex": "x" })).text("preview")).toBeUndefined();
  expect(compiler.requests[0]?.manifest.preview).toBeUndefined();
  const preview = { project: { preview: true } };
  expect(
    (await run({ "main.tex": "x" }, preview)).entries.get("preview"),
  ).toEqual(png);
  expect(compiler.requests[1]?.manifest.preview).toBe(true);
  for (let index = 0; index < 2; index++)
    await expect(run({ "main.tex": "x" }, preview)).rejects.toThrow(
      "invalid preview",
    );
});

test("compile failures are terminal and carry the full log; everything else is retryable", async () => {
  for (const status of [408, 413, 422] as const) {
    const { run } = harness(() => ({
      status,
      error: "Failed",
      log: "summary",
      files: { "main.log": "full transcript" },
    }));
    const { sinks, text } = collectSinks();
    const error = await run({ "main.tex": "x" }, { artifacts: sinks }).catch(
      (cause) => cause,
    );
    expect(text("file:main.log")).toBe("full transcript");
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status,
      message: "Failed",
      log: "summary",
      timing: { compileMs: 1 },
    });
  }
  const invalid = harness(() =>
    Response.json({ error: "Bad paths", code: "invalid" }, { status: 400 }),
  );
  expect(
    await invalid.run({ "main.tex": "x" }).catch((cause) => cause),
  ).toMatchObject({ status: 400, message: "Bad paths" });
  for (const response of [
    () => Response.json({ error: "Full", code: "saturated" }, { status: 503 }),
    () => new Response("gateway", { status: 502 }),
    () => Response.json({ error: "Ended", code: "lease" }, { status: 409 }),
    () =>
      new Response("%PDF", {
        headers: { "Content-Type": "application/pdf" },
      }),
  ]) {
    const { run } = harness(response);
    expect(
      await run({ "main.tex": "x" }).catch((cause) => cause),
    ).toBeInstanceOf(EngineError);
  }
});

test("a truncated response is retryable and its container is not trusted again", async () => {
  let truncate = true;
  const { compiler, run } = harness(async ({ manifest }) => {
    const response = fixtureResponse(manifest, { pdf: "%PDF", log: "ok" });
    if (!truncate) return response;
    const data = await response.arrayBuffer();
    return new Response(data.slice(0, 1200), { headers: response.headers });
  });
  expect(await run({ "main.tex": "x" }).catch((cause) => cause)).toBeInstanceOf(
    EngineError,
  );
  truncate = false;
  await run({ "main.tex": "x" });
  expect(compiler.requests[1]?.options.container).toBeUndefined();
});

test("a lost container costs one full retry before the overflow queue", async () => {
  let lost = 0;
  const { compiler, run } = harness(() => {
    if (!lost) return { pdf: "%PDF" };
    lost--;
    return Response.json(
      { error: "The compile container failed", code: "unavailable" },
      { status: 503 },
    );
  });
  await run({ "main.tex": "one" });
  lost = 1;
  await run({ "main.tex": "two" });
  expect(compiler.requests.map(({ options }) => options.container)).toEqual([
    undefined,
    "compiler-1",
    undefined,
  ]);
  lost = 2;
  await expect(run({ "main.tex": "three" })).rejects.toBeInstanceOf(
    EngineError,
  );
  expect(compiler.requests).toHaveLength(5);
});

test("a failed TeX run still leaves the container incremental", async () => {
  let fail = true;
  const { compiler, run } = harness(() =>
    fail ? { status: 422, error: "Bad TeX", log: "" } : { pdf: "%PDF" },
  );
  await expect(run({ "main.tex": "bad", "a.tex": "a" })).rejects.toThrow(
    "Bad TeX",
  );
  fail = false;
  await run({ "main.tex": "good", "a.tex": "a" });
  expect(compiler.requests[1]).toMatchObject({
    options: { container: "compiler-1" },
    received: await hashes("good"),
  });
});

test("cancelling stops the compiler's run before the build settles", async () => {
  const started = Promise.withResolvers<string>();
  const { compiler, run } = harness(async ({ options }) => {
    started.resolve(options.id);
    while (!compiler.cancelled.includes(options.id)) await Bun.sleep(1);
    return Response.json(
      { error: "Compilation cancelled", code: "cancelled" },
      { status: 409 },
    );
  });
  const controller = new AbortController();
  const pending = run({ "main.tex": "x" }, { signal: controller.signal });
  void pending.catch(() => {});
  const id = await started.promise;
  controller.abort(new Error("superseded"));
  const error = await pending.catch((cause) => cause);
  expect(error).toBeInstanceOf(EngineError);
  expect(compiler.cancelled).toEqual([id]);
});

test("a build cancelled before it starts never reaches the compiler", async () => {
  const { compiler, run } = harness();
  const controller = new AbortController();
  controller.abort();
  await expect(
    run({ "main.tex": "x" }, { signal: controller.signal }),
  ).rejects.toBeInstanceOf(EngineError);
  expect(compiler.requests).toEqual([]);
});

test("a source that left storage fails the build instead of retrying it", async () => {
  const { run } = harness();
  await expect(
    run(
      { "main.tex": "x" },
      {
        readSource: async () => {
          throw new MissingSourceError();
        },
      },
    ),
  ).rejects.toBeInstanceOf(MissingSourceError);
});

test("a PDF stored under another name fails the build", async () => {
  const { run } = harness(() =>
    fixtureResponse({ mainFile: "other.tex" }, { pdf: "%PDF", log: "ok" }),
  );
  await expect(run({ "main.tex": "x" })).rejects.toThrow("unexpected PDF");
});

test("small sources are read ahead a few at a time and large ones only when sent", async () => {
  const large = "x".repeat(600 * 1024);
  const files: Record<string, string> = {
    "main.tex": "main",
    "big.bin": large,
  };
  for (let index = 0; index < 20; index++) files[`${index}.tex`] = `${index}`;
  const { synced, contents } = await project(files);
  const bigHash = synced.files["big.bin"]!.hash;
  const reads: string[] = [];
  const started = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const fixture = createCompilerFixture(() => ({ pdf: "%PDF", log: "ok" }));
  const engine = createCompilerEngine({
    projectId,
    store: memoryStore(),
    cacheKey: key,
    fetch: async (path, init) => {
      started.resolve();
      await proceed.promise;
      return fixture.fetch(path, init);
    },
    pause: async () => {},
  });
  const run = engine(synced, {
    jobId: "job",
    plan: "pro",
    attempt: 1,
    artifacts: collectSinks().sinks,
    readSource: async (file) => {
      reads.push(file.hash);
      return new Blob([contents.get(file.hash)!]).stream();
    },
  });
  await started.promise;
  await Bun.sleep(5);
  expect(reads).toHaveLength(5);
  expect(reads).not.toContain(bigHash);
  proceed.resolve();
  await run;
  expect(reads).toHaveLength(22);
  expect(fixture.requests[0]?.received).toHaveLength(22);
  expect(
    new TextDecoder().decode(fixture.requests[0]?.sources["big.bin"]),
  ).toBe(large);
});

test("the PDF reaches its sink with a first-byte time before the build finishes", async () => {
  const { run } = harness(() => ({ pdf: "%PDF-early", log: "ok" }));
  const output = await run({ "main.tex": "x" });
  expect(output.text("pdf")).toBe("%PDF-early");
  expect(output.timing.firstPdfByteMs).toBeNumber();
});
