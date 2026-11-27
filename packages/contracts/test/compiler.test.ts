import { expect, test } from "bun:test";

import { collectArchive, readArchive, writeArchive } from "../src/archive";
import {
  compileOptionsSchema,
  compileOptionHeaders,
  encodeCompileHeaders,
  encodeCompileRequest,
  collectCompileArtifacts,
  readCompileArtifacts,
  readCompilePlacement,
  readCompileRejection,
  type CompileOptions,
} from "../src/compiler";

const bytes = (text: string) => new TextEncoder().encode(text);
const collect = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());
const chunked = (data: Uint8Array, size: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < data.length; offset += size)
        controller.enqueue(data.slice(offset, offset + size));
      controller.close();
    },
  });
const artifacts = (
  entries: [string, string | Uint8Array][] = [
    ["output.pdf", "%PDF"],
    [
      "result.json",
      JSON.stringify({ log: "ok", pdf: "main.pdf", files: ["main.log"] }),
    ],
    ["artifacts/0", "transcript"],
    ["cache.tar.zst", "cache"],
  ],
) =>
  collect(
    writeArchive(
      entries.map(([name, value]) => {
        const content = typeof value === "string" ? bytes(value) : value;
        return { name, size: content.length, content };
      }),
    ).body,
  );

test("archives round trip through every chunk size and report their exact length", async () => {
  const entries = ["", "a", "x".repeat(511), "y".repeat(512), "z".repeat(1500)];
  const archive = writeArchive(
    entries.map((content, index) => ({
      name: `entries/${index}`,
      size: content.length,
      content:
        index % 2 ? bytes(content) : async () => chunked(bytes(content), 7),
    })),
  );
  const data = await collect(archive.body);
  expect(data.length).toBe(archive.size);
  for (const size of [1, 13, 512, 4096, data.length]) {
    const read = await collectArchive(chunked(data, size), { maxBytes: 1e6 });
    expect(
      [...read].map(([name, content]) => [
        name,
        new TextDecoder().decode(content),
      ]),
    ).toEqual(entries.map((content, index) => [`entries/${index}`, content]));
  }
});

test("the archive format is plain ustar that tar can list", async () => {
  const data = await artifacts();
  const listed = Bun.spawnSync(["tar", "-tf", "-"], { stdin: data });
  expect(listed.stdout.toString().trim().split("\n")).toEqual([
    "output.pdf",
    "result.json",
    "artifacts/0",
    "cache.tar.zst",
  ]);
});

test("truncated, corrupt, oversized and duplicate archives are rejected", async () => {
  const data = await artifacts();
  for (const length of [
    0,
    100,
    512,
    1024,
    data.length - 1024,
    data.length - 600,
  ])
    await expect(
      collectArchive(chunked(data.slice(0, length), 300), { maxBytes: 1e6 }),
    ).rejects.toThrow("Truncated archive");
  const corrupt = data.slice();
  corrupt[3]!++;
  await expect(
    collectArchive(chunked(corrupt, 512), { maxBytes: 1e6 }),
  ).rejects.toThrow("Invalid archive entry");
  await expect(
    collectArchive(chunked(data, 512), { maxBytes: 1000 }),
  ).rejects.toThrow("exceeds its limit");
  const duplicate = await artifacts([
    ["a", "1"],
    ["a", "2"],
  ]);
  await expect(
    collectArchive(chunked(duplicate, 512), { maxBytes: 1e6 }),
  ).rejects.toThrow("Invalid archive entry");
});

test("an entry that changes size fails instead of shifting later entries", async () => {
  const archive = writeArchive([
    { name: "a", size: 3, content: async () => bytes("four") },
  ]);
  await expect(collect(archive.body)).rejects.toThrow("changed size");
});

test("cancelling an archive releases the entry it was reading", async () => {
  let cancelled = false;
  const archive = writeArchive([
    {
      name: "a",
      size: 1e6,
      content: async () =>
        new ReadableStream<Uint8Array>({
          pull: (controller) => controller.enqueue(new Uint8Array(1000)),
          cancel: () => {
            cancelled = true;
          },
        }),
    },
  ]);
  const reader = archive.body.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  expect(cancelled).toBe(true);
});

test("options survive their headers, and invalid ones are refused", () => {
  const options: CompileOptions = {
    id: crypto.randomUUID(),
    affinity: "project:1",
    timeoutMs: 15_000,
    priority: 1,
    container: "compiler-a",
  };
  const parse = (headers: Record<string, string>) =>
    compileOptionsSchema.parse(compileOptionHeaders(new Headers(headers)));
  expect(parse(encodeCompileHeaders(options))).toEqual(options);
  const { container: _, ...full } = options;
  expect(parse(encodeCompileHeaders(full))).toEqual(full);
  for (const change of [
    { id: "not-a-uuid" },
    { affinity: "" },
    { affinity: "a/b" },
    { timeoutMs: 0 },
    { timeoutMs: 300_001 },
    { timeoutMs: 1.5 },
    { priority: 10 },
    { container: "a b" },
  ])
    expect(() =>
      parse(encodeCompileHeaders({ ...options, ...change })),
    ).toThrow();
});

test("requests put the manifest first and load blobs lazily in order", async () => {
  const loaded: string[] = [];
  const hash = "a".repeat(64);
  const request = encodeCompileRequest({
    manifest: {
      mainFile: "main.tex",
      files: { "main.tex": hash },
      incremental: true,
    },
    blobs: [
      {
        hash,
        size: 5,
        content: async () => {
          loaded.push("blob");
          return bytes("hello");
        },
      },
    ],
    cache: {
      size: 4,
      content: async () => {
        loaded.push("cache");
        return bytes("zstd");
      },
    },
  });
  expect(loaded).toEqual([]);
  const entries = await collectArchive(request.body, { maxBytes: 1e6 });
  expect([...entries.keys()]).toEqual([
    "manifest.json",
    `blobs/${hash}`,
    "cache.tar.zst",
  ]);
  expect(loaded).toEqual(["blob", "cache"]);
  expect(
    JSON.parse(new TextDecoder().decode(entries.get("manifest.json"))),
  ).toEqual({
    mainFile: "main.tex",
    files: { "main.tex": hash },
    incremental: true,
  });
});

test("each part reaches its sink as it arrives, and only the result is held", async () => {
  const pdf = crypto.getRandomValues(new Uint8Array(5000));
  const data = await artifacts([
    ["output.pdf", pdf],
    [
      "result.json",
      JSON.stringify({ log: "ok", pdf: "main.pdf", files: ["main.log", "a"] }),
    ],
    ["preview.png", "png"],
    ["artifacts/0", "transcript"],
    ["artifacts/1", ""],
    ["cache.tar.zst", "cache"],
  ]);
  const tail = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const events: string[] = [];
  let chunks = 0;
  const sink = (name: string, size: number) => {
    const parts: Uint8Array[] = [];
    return {
      write: (part: Uint8Array) => {
        chunks++;
        parts.push(part.slice());
      },
      close: async () => {
        const content = await new Blob(
          parts as Uint8Array<ArrayBuffer>[],
        ).text();
        expect(new Blob(parts as Uint8Array<ArrayBuffer>[]).size).toBe(size);
        events.push(name === "pdf" ? "pdf" : `${name}:${content}`);
        if (name === "pdf") received.resolve();
      },
    };
  };
  const reading = readCompileArtifacts(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(data.slice(0, 700));
        controller.enqueue(data.slice(700, 512 + 5000));
        await tail.promise;
        controller.enqueue(data.slice(512 + 5000));
        controller.close();
      },
    }),
    {
      pdf: (size) => sink("pdf", size),
      preview: (size) => sink("preview", size),
      file: (path, size) => sink(path, size),
      cache: (size) => sink("cache", size),
    },
  );
  // The PDF finished while the rest of the response does not exist yet.
  await received.promise;
  expect(chunks).toBe(2);
  tail.resolve();
  expect(await reading).toMatchObject({ log: "ok", pdf: "main.pdf" });
  expect(events).toEqual([
    "pdf",
    "preview:png",
    "main.log:transcript",
    "a:",
    "cache:cache",
  ]);
});

test("a slow sink holds the archive back", async () => {
  let pulled = 0;
  const data = await artifacts([["output.pdf", "x".repeat(50_000)]]);
  const release = Promise.withResolvers<void>();
  const slow = readArchive(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(data.slice(pulled, pulled + 1000));
          pulled += 1000;
          if (pulled >= data.length) controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    { maxBytes: 1e6, open: () => ({ write: () => release.promise }) },
  );
  await Bun.sleep(5);
  expect(pulled).toBe(1000);
  release.resolve();
  await slow;
  expect(pulled).toBeGreaterThan(50_000);
});

test("a response cut short aborts the sink it was filling", async () => {
  const data = await artifacts([["output.pdf", "x".repeat(2000)]]);
  let cause: unknown;
  let closed = false;
  await expect(
    readCompileArtifacts(chunked(data.slice(0, 1200), 600), {
      pdf: () => ({
        write: () => {},
        close: () => {
          closed = true;
        },
        abort: (error) => {
          cause = error;
        },
      }),
    }),
  ).rejects.toThrow("Truncated archive");
  expect(cause).toBeInstanceOf(Error);
  expect(closed).toBe(false);
});

test("a result that could exhaust memory is refused", async () => {
  await expect(
    collectCompileArtifacts(
      chunked(
        await artifacts([["result.json", "x".repeat(4 * 1024 * 1024 + 1)]]),
        65536,
      ),
    ),
  ).rejects.toThrow("exceeds its limit");
});

test.each([
  ["no result", [["output.pdf", "%PDF"]], "no result"],
  ["empty PDF", [["output.pdf", ""]], "empty PDF"],
  [
    "PDF after the result",
    [
      ["result.json", JSON.stringify({ log: "", pdf: "main.pdf", files: [] })],
      ["output.pdf", "%PDF"],
    ],
    "PDF first",
  ],
  [
    "missing artifact",
    [
      ["output.pdf", "%PDF"],
      [
        "result.json",
        JSON.stringify({ log: "", pdf: "main.pdf", files: ["a"] }),
      ],
    ],
    "omitted an artifact",
  ],
  [
    "PDF without a name",
    [
      ["output.pdf", "%PDF"],
      ["result.json", JSON.stringify({ log: "", files: [] })],
    ],
    "does not match",
  ],
] satisfies [string, [string, string][], string][])(
  "responses with %s are rejected",
  async (_name, entries, message) => {
    await expect(
      collectCompileArtifacts(chunked(await artifacts(entries), 512)),
    ).rejects.toThrow(message);
  },
);

test("failures, rejections and placement decode, and unknown shapes do not", async () => {
  const failed = await collectCompileArtifacts(
    chunked(
      await artifacts([
        [
          "result.json",
          JSON.stringify({ error: "Failed", log: "bad", files: ["main.log"] }),
        ],
        ["artifacts/0", "bad"],
      ]),
      512,
    ),
  );
  expect(failed).toMatchObject({ pdf: null, result: { error: "Failed" } });
  expect(
    await readCompileRejection(
      Response.json({ error: "Resync", code: "resync", missing: [] }),
    ),
  ).toEqual({ error: "Resync", code: "resync", missing: [] });
  for (const body of ["{}", "nonsense", '{"error":"x","code":"other"}'])
    expect(await readCompileRejection(new Response(body))).toBeNull();
  const placement = { container: "compiler-a", outcome: "spare", waitMs: 3 };
  expect(
    readCompilePlacement(
      new Headers({ "X-Compile-Placement": JSON.stringify(placement) }),
    ),
  ).toEqual(placement as never);
  expect(readCompilePlacement(new Headers())).toBeNull();
});
