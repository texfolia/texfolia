import { expect, test } from "bun:test";

import { Schema } from "effect";

import { readArchive, writeArchive } from "../src/archive";
import {
  CompileOptions,
  compileOptionHeaders,
  encodeCompileHeaders,
  encodeCompileRequest,
  readCompileArtifacts,
  readCompilePlacement,
  readCompileRejection,
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
    const read = await readArchive(chunked(data, size), { maxBytes: 1e6 });
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
      readArchive(chunked(data.slice(0, length), 300), { maxBytes: 1e6 }),
    ).rejects.toThrow("Truncated archive");
  const corrupt = data.slice();
  corrupt[3]!++;
  await expect(
    readArchive(chunked(corrupt, 512), { maxBytes: 1e6 }),
  ).rejects.toThrow("Invalid archive entry");
  await expect(
    readArchive(chunked(data, 512), { maxBytes: 1000 }),
  ).rejects.toThrow("exceeds its limit");
  const duplicate = await artifacts([
    ["a", "1"],
    ["a", "2"],
  ]);
  await expect(
    readArchive(chunked(duplicate, 512), { maxBytes: 1e6 }),
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
  const decode = Schema.decodeUnknownSync(CompileOptions);
  const parse = (headers: Record<string, string>) =>
    decode(compileOptionHeaders(new Headers(headers)));
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
  const entries = await readArchive(request.body, { maxBytes: 1e6 });
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

test("the PDF is delivered before the rest of the response exists", async () => {
  const pdf = crypto.getRandomValues(new Uint8Array(5000));
  const data = await artifacts([
    ["output.pdf", pdf],
    ["result.json", JSON.stringify({ log: "ok", pdf: "main.pdf", files: [] })],
  ]);
  const tail = Promise.withResolvers<void>();
  const preview = Promise.withResolvers<Uint8Array>();
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
    (body) => void collect(body).then(preview.resolve, preview.reject),
  );
  expect(await preview.promise).toEqual(pdf);
  tail.resolve();
  expect((await reading).pdf).toEqual(pdf);
});

test("a consumer that cancels its PDF does not disturb the artifacts", async () => {
  const result = await readCompileArtifacts(
    chunked(await artifacts(), 64),
    (body) => void body.cancel(),
  );
  expect(result).toMatchObject({
    result: { log: "ok", pdf: "main.pdf" },
    preview: null,
  });
  expect(new TextDecoder().decode(result.files.get("main.log"))).toBe(
    "transcript",
  );
  expect(new TextDecoder().decode(result.cache!)).toBe("cache");
});

test("a response cut short errors the streamed PDF and the result", async () => {
  const data = await artifacts([["output.pdf", "x".repeat(2000)]]);
  let streamed: Promise<unknown> | undefined;
  await expect(
    readCompileArtifacts(chunked(data.slice(0, 1200), 600), (body) => {
      streamed = collect(body).catch((error: unknown) => error);
    }),
  ).rejects.toThrow("Truncated archive");
  expect(await streamed).toBeInstanceOf(Error);
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
      readCompileArtifacts(chunked(await artifacts(entries), 512)),
    ).rejects.toThrow(message);
  },
);

test("failures, rejections and placement decode, and unknown shapes do not", async () => {
  const failed = await readCompileArtifacts(
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
