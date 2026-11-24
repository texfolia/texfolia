import { expect, test } from "bun:test";

import { createTemplatePreviewStream } from "./preview.server";

function compilerSnapshot(
  revision: number,
  job: {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed";
  } | null,
) {
  const createdAt = "2026-11-23T00:00:00.000Z";
  const current = !job
    ? null
    : job.status === "queued"
      ? { id: job.id, revision, status: "queued" as const, createdAt }
      : job.status === "running"
        ? {
            id: job.id,
            revision,
            status: "running" as const,
            createdAt,
            startedAt: createdAt,
          }
        : job.status === "succeeded"
          ? {
              id: job.id,
              revision,
              status: "succeeded" as const,
              createdAt,
              startedAt: createdAt,
              finishedAt: createdAt,
              log: "",
              artifactUrl: `/projects/t/compilations/${job.id}.pdf`,
              sizeBytes: 12,
            }
          : {
              id: job.id,
              revision,
              status: "failed" as const,
              createdAt,
              startedAt: createdAt,
              finishedAt: createdAt,
              error: "TeX error",
              log: "",
            };
  return {
    revision,
    current,
    latestBuild:
      current && (current.status === "succeeded" || current.status === "failed")
        ? current
        : null,
    artifacts: null,
    stale: false,
  };
}

test("pushes ready once the compiler event stream reports job completion", async () => {
  const jobId = crypto.randomUUID();
  const templateId = crypto.randomUUID();
  const encoder = new TextEncoder();
  let push!: (chunk: string) => void;
  let closedUpstream = false;

  const compiler = {
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      expect(url.pathname).toBe(`/projects/${templateId}/events`);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (chunk) => controller.enqueue(encoder.encode(chunk));
        },
        cancel() {
          closedUpstream = true;
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  } satisfies Pick<Fetcher, "fetch">;

  let advances = 0;
  const response = createTemplatePreviewStream({
    templateId,
    initialJobId: jobId,
    compiler,
    signal: new AbortController().signal,
    advance: async () => {
      advances++;
      return { previewStatus: "ready", previewJobId: jobId };
    },
  });

  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  // Wait a microtask for the stream to attach to the fake compiler.
  await Bun.sleep(10);
  push(
    `data: ${JSON.stringify(compilerSnapshot(1, { id: jobId, status: "queued" }))}\n\n`,
  );
  push(": heartbeat\n\n");
  const heartbeat = await reader.read();
  expect(decoder.decode(heartbeat.value)).toBe(": heartbeat\n\n");
  expect(advances).toBe(0);

  push(
    `data: ${JSON.stringify(compilerSnapshot(2, { id: jobId, status: "running" }))}\n\n`,
  );
  await Bun.sleep(10);
  expect(advances).toBe(0);

  push(
    `data: ${JSON.stringify(compilerSnapshot(3, { id: jobId, status: "succeeded" }))}\n\n`,
  );
  const settled = await reader.read();
  expect(decoder.decode(settled.value)).toBe(
    'data: {"previewStatus":"ready"}\n\n',
  );
  expect((await reader.read()).done).toBe(true);
  expect(advances).toBe(1);
  expect(closedUpstream).toBe(true);
});

test("settles when another viewer clears the temporary compiler project", async () => {
  const jobId = crypto.randomUUID();
  const templateId = crypto.randomUUID();
  const encoder = new TextEncoder();
  let push!: (chunk: string) => void;

  const compiler = {
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            push = (chunk) => controller.enqueue(encoder.encode(chunk));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  } satisfies Pick<Fetcher, "fetch">;

  let checks = 0;
  const response = createTemplatePreviewStream({
    templateId,
    initialJobId: jobId,
    compiler,
    signal: new AbortController().signal,
    advance: async () => {
      checks++;
      // First check sees another worker mid-lease; second check after clear sees failed.
      return checks === 1
        ? { previewStatus: "queued", previewJobId: jobId }
        : { previewStatus: "failed", previewJobId: jobId };
    },
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  await Bun.sleep(10);

  push(
    `data: ${JSON.stringify(compilerSnapshot(2, { id: jobId, status: "failed" }))}\n\n`,
  );
  await Bun.sleep(10);
  expect(checks).toBe(1);

  push(`data: ${JSON.stringify(compilerSnapshot(3, null))}\n\n`);
  const settled = await reader.read();
  expect(decoder.decode(settled.value)).toBe(
    'data: {"previewStatus":"failed"}\n\n',
  );
  expect((await reader.read()).done).toBe(true);
  expect(checks).toBe(2);
});

test("aborts the upstream compiler stream when the client disconnects", async () => {
  const jobId = crypto.randomUUID();
  const templateId = crypto.randomUUID();
  let upstreamAborted = false;

  const compiler = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        upstreamAborted = true;
      });
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  } satisfies Pick<Fetcher, "fetch">;

  const controller = new AbortController();
  const response = createTemplatePreviewStream({
    templateId,
    initialJobId: jobId,
    compiler,
    signal: controller.signal,
    advance: async () => ({ previewStatus: "queued", previewJobId: jobId }),
  });

  await Bun.sleep(10);
  controller.abort();
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(true);
  expect(upstreamAborted).toBe(true);
});

test("sends retry backoff and closes cleanly when the compiler event stream is unavailable", async () => {
  const compiler = {
    fetch: async () => new Response("Unavailable", { status: 503 }),
  } satisfies Pick<Fetcher, "fetch">;

  const response = createTemplatePreviewStream({
    templateId: crypto.randomUUID(),
    initialJobId: crypto.randomUUID(),
    compiler,
    signal: new AbortController().signal,
    advance: async () => null,
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  expect(await response.text()).toBe("retry: 3000\n: unavailable\n\n");
});
