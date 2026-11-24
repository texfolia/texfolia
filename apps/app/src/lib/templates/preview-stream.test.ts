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

// The builds side of one socket, as a Worker sees it.
function fakeBuilds() {
  const listeners = new Map<string, (event: { data?: string }) => void>();
  const state = { path: "", upgrade: "", accepted: false, closed: false };
  const socket = {
    accept: () => {
      state.accepted = true;
    },
    addEventListener: (
      type: string,
      listener: (event: { data?: string }) => void,
    ) => void listeners.set(type, listener),
    close: () => {
      state.closed = true;
    },
  };
  return {
    state,
    push: (snapshot: unknown) =>
      listeners.get("message")?.({ data: JSON.stringify(snapshot) }),
    drop: () => listeners.get("close")?.({}),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      state.path = new URL(String(input)).pathname;
      state.upgrade = new Headers(init?.headers).get("Upgrade") ?? "";
      return { webSocket: socket, body: null } as unknown as Response;
    },
  };
}

test("pushes ready once the build socket reports job completion", async () => {
  const jobId = crypto.randomUUID();
  const templateId = crypto.randomUUID();
  const builds = fakeBuilds();
  let advances = 0;
  const response = createTemplatePreviewStream({
    templateId,
    initialJobId: jobId,
    builds,
    signal: new AbortController().signal,
    advance: async () => {
      advances++;
      return { previewStatus: "ready", previewJobId: jobId };
    },
  });
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  // Wait for the stream to attach to the fake builds.
  await Bun.sleep(10);
  expect(builds.state).toMatchObject({
    path: `/projects/${templateId}/events`,
    upgrade: "websocket",
    accepted: true,
  });
  builds.push(compilerSnapshot(1, { id: jobId, status: "queued" }));
  builds.push("not a snapshot");
  builds.push(compilerSnapshot(2, { id: jobId, status: "running" }));
  await Bun.sleep(10);
  expect(advances).toBe(0);

  builds.push(compilerSnapshot(3, { id: jobId, status: "succeeded" }));
  const settled = await reader.read();
  expect(decoder.decode(settled.value)).toBe(
    'data: {"previewStatus":"ready"}\n\n',
  );
  expect((await reader.read()).done).toBe(true);
  expect(advances).toBe(1);
  expect(builds.state.closed).toBe(true);
});

test("settles when another viewer clears the temporary compiler project", async () => {
  const jobId = crypto.randomUUID();
  const builds = fakeBuilds();
  let checks = 0;
  const response = createTemplatePreviewStream({
    templateId: crypto.randomUUID(),
    initialJobId: jobId,
    builds,
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
  await Bun.sleep(10);

  builds.push(compilerSnapshot(2, { id: jobId, status: "failed" }));
  await Bun.sleep(10);
  expect(checks).toBe(1);

  builds.push(compilerSnapshot(3, null));
  const settled = await reader.read();
  expect(new TextDecoder().decode(settled.value)).toBe(
    'data: {"previewStatus":"failed"}\n\n',
  );
  expect((await reader.read()).done).toBe(true);
  expect(checks).toBe(2);
});

test("a dropped build socket checks once and then asks the page to retry", async () => {
  const jobId = crypto.randomUUID();
  const builds = fakeBuilds();
  let checks = 0;
  const response = createTemplatePreviewStream({
    templateId: crypto.randomUUID(),
    initialJobId: jobId,
    builds,
    signal: new AbortController().signal,
    advance: async () => {
      checks++;
      return { previewStatus: "queued", previewJobId: jobId };
    },
  });
  await Bun.sleep(10);
  builds.drop();
  expect(await response.text()).toBe("retry: 3000\n\n");
  expect(checks).toBe(1);
});

test("closes the build socket when the client disconnects", async () => {
  const jobId = crypto.randomUUID();
  for (const how of ["abort", "cancel"] as const) {
    const builds = fakeBuilds();
    const controller = new AbortController();
    const response = createTemplatePreviewStream({
      templateId: crypto.randomUUID(),
      initialJobId: jobId,
      builds,
      signal: controller.signal,
      advance: async () => ({ previewStatus: "queued", previewJobId: jobId }),
    });
    await Bun.sleep(10);
    const reader = response.body!.getReader();
    if (how === "abort") controller.abort();
    else await reader.cancel();
    expect((await reader.read()).done).toBe(true);
    expect(builds.state.closed).toBe(true);
  }
});

test("sends retry backoff and closes cleanly when the build socket is unavailable", async () => {
  const response = createTemplatePreviewStream({
    templateId: crypto.randomUUID(),
    initialJobId: crypto.randomUUID(),
    builds: {
      fetch: async () => new Response("Unavailable", { status: 503 }),
    },
    signal: new AbortController().signal,
    advance: async () => null,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  expect(await response.text()).toBe("retry: 3000\n: unavailable\n\n");
});
