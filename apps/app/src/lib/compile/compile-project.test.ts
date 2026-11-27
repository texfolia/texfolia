import { afterEach, expect, test } from "bun:test";

import { type BuildSnapshot, previewTimingSchema } from "@texfolia/contracts";

import { requestCompilation } from "./compile-project";
import { reportCompilePreview, trackCompilePreview } from "./compile-telemetry";
import { ProjectBuildEvents } from "./project-build-events";

const originalFetch = globalThis.fetch;
const streams: ProjectBuildEvents[] = [];

// Stands in for every socket a build stream opens, in turn.
class FakeSocket {
  static latest: FakeSocket;
  readyState = 1 as const;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.latest = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}
const source = {
  get closed() {
    return FakeSocket.latest.closed;
  },
  message(value: unknown) {
    FakeSocket.latest.onmessage?.call(
      FakeSocket.latest as unknown as WebSocket,
      new MessageEvent("message", {
        data: typeof value === "string" ? value : JSON.stringify(value),
      }),
    );
  },
  drop() {
    FakeSocket.latest.onclose?.call(
      FakeSocket.latest as unknown as WebSocket,
      new CloseEvent("close"),
    );
  },
  async reconnect() {
    const dropped = FakeSocket.latest;
    while (FakeSocket.latest === dropped) await Bun.sleep(5);
  },
};

function openEvents(onSnapshot: (snapshot: BuildSnapshot) => void = () => {}) {
  const events = new ProjectBuildEvents(
    "project",
    onSnapshot,
    (url) => new FakeSocket(url),
  );
  streams.push(events);
  return { events, source };
}

afterEach(() => {
  for (const stream of streams.splice(0)) stream.close();
  globalThis.fetch = originalFetch;
});

for (const saveStatus of ["succeeded", "failed"] as const) {
  test(`streamed preview renders before ${saveStatus} persistence completes`, async () => {
    const { events, source } = openEvents();
    const previewReady = Promise.withResolvers<File>();
    const reportReady = Promise.withResolvers<unknown>();
    let jobId = "";
    let completed = false;
    let downloads = 0;
    let reports = 0;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          jobId = new Headers(init.headers).get("X-Compilation-Id")!;
          return Response.json({
            id: jobId,
            revision: 1,
            statusUrl: "/status",
            previewUrl: "/preview",
          });
        }
        if (init?.method === "PATCH") {
          reports++;
          reportReady.resolve(JSON.parse(String(init.body)));
          return new Response(null, { status: 204 });
        }
        if (url === "/preview") {
          downloads++;
          return new Response("%PDF-streamed", {
            headers: { "Content-Type": "application/pdf" },
          });
        }
        if (url === "/status")
          return Response.json({
            id: jobId,
            revision: 1,
            status: saveStatus,
            log: "streamed log",
            error: "PDF could not be saved",
            artifactUrl: "/must-not-download",
          });
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const result = requestCompilation({
      projectId: "project",
      events,
      mainFile: "main.tex",
      files: {},
      signal: new AbortController().signal,
      onPreview: ({ pdf }) => {
        previewReady.resolve(pdf);
        reportCompilePreview(pdf, "rendered");
      },
    });
    void result.then(() => {
      completed = true;
    });
    const preview = await previewReady.promise;
    expect(await preview.text()).toBe("%PDF-streamed");
    expect(completed).toBe(false);
    expect(reports).toBe(0);
    source.message(snapshot(jobId, saveStatus));
    const final = await result;
    expect(
      previewTimingSchema.parse(await reportReady.promise).firstPdfByteMs,
    ).toBeNumber();
    expect(reports).toBe(1);
    if (saveStatus === "succeeded") {
      expect(final).toMatchObject({ pdf: preview, log: "streamed log" });
    } else {
      expect(final).toEqual({
        error: "PDF could not be saved",
        log: "streamed log",
      });
      expect(await preview.text()).toBe("%PDF-streamed");
    }
    expect(downloads).toBe(1);
  });
}

function snapshot(
  id: string,
  status: NonNullable<BuildSnapshot["current"]>["status"],
  revision = 1,
): BuildSnapshot {
  const build = { id, revision, status };
  return {
    revision,
    current: build,
    latestBuild: status === "succeeded" ? build : null,
    stale: false,
    artifacts: null,
  };
}

async function compilation(uncertainSubmission = false) {
  const { events, source } = openEvents();
  const controller = new AbortController();
  let jobId = "";
  let reads = 0;
  let downloads = 0;
  let jobStatus: "queued" | "running" | "succeeded" | "failed" = "running";
  let recoveryFailure: "network" | "server" | null = null;
  let statusResponse: Promise<Response> | null = null;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        jobId = new Headers(init.headers).get("X-Compilation-Id") ?? "";
        return Response.json(
          {
            id: jobId,
            revision: uncertainSubmission ? undefined : 1,
            statusUrl: `/status?job=${jobId}`,
          },
          { status: 202 },
        );
      }
      if (String(input).startsWith("/pdf")) {
        downloads++;
        return new Response("%PDF-push");
      }
      reads++;
      if (recoveryFailure === "network") throw new Error("offline");
      if (recoveryFailure === "server")
        return Response.json({ error: "unavailable" }, { status: 503 });
      if (statusResponse) return statusResponse;
      return Response.json({
        id: jobId,
        status: jobStatus,
        revision: 1,
        log: "engine log",
        error: "bad TeX",
        artifactUrl: "/pdf",
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const result = requestCompilation({
    projectId: "project",
    events,
    mainFile: "main.tex",
    files: {},
    signal: controller.signal,
  });
  let settled = false;
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Bun.sleep(0);
  return {
    result,
    source,
    controller,
    events,
    get jobId() {
      return jobId;
    },
    get reads() {
      return reads;
    },
    get downloads() {
      return downloads;
    },
    get settled() {
      return settled;
    },
    setStatus(value: typeof jobStatus) {
      jobStatus = value;
    },
    failRecovery(value: typeof recoveryFailure) {
      recoveryFailure = value;
    },
    deferStatus(value: Promise<Response>) {
      statusResponse = value;
    },
  };
}

test("submission carries the browser job ID and preview reports only once after rendering", async () => {
  const originalFetch = globalThis.fetch;
  const { events, source } = openEvents();
  const reports: unknown[] = [];
  const reportReady = Promise.withResolvers<void>();
  let jobId = "";
  const startedAt = performance.now();
  const lastEditAt = startedAt - 100;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(
        new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          "http://local",
        ),
        init,
      );
      if (request.method === "POST") {
        jobId = request.headers.get("X-Compilation-Id") ?? "";
        expect(jobId).toMatch(/^[a-f0-9-]{36}$/);
        expect(await request.json()).toEqual({
          mainFile: "main.tex",
          baseRevision: 0,
          revision: 1,
          files: {
            "main.tex": {
              hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
              content: "hello",
            },
          },
          deleted: [],
        });
        source.message(snapshot(jobId, "succeeded"));
        return Response.json(
          {
            id: jobId,
            revision: 1,
            statusUrl: `/api/compile/project?job=${jobId}`,
          },
          { status: 202 },
        );
      }
      if (request.method === "PATCH") {
        expect(new URL(request.url).searchParams.get("job")).toBe(jobId);
        reports.push(await request.json());
        reportReady.resolve();
        return new Response(null, { status: 204 });
      }
      if (request.url.includes("artifact=pdf"))
        return new Response("%PDF-1.5", {
          headers: { "Content-Type": "application/pdf" },
        });
      return Response.json({
        id: jobId,
        status: "succeeded",
        log: "ok",
        artifactUrl: `/api/compile/project?job=${jobId}&artifact=pdf`,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const result = await requestCompilation({
      projectId: "project",
      events,
      mainFile: "main.tex",
      files: { "main.tex": "hello" },
      signal: new AbortController().signal,
      startedAt,
      lastEditAt,
    });
    expect("pdf" in result).toBe(true);
    if (!("pdf" in result)) throw new Error(result.error);
    expect(await result.pdf.text()).toBe("%PDF-1.5");
    expect(reports).toHaveLength(0);
    reportCompilePreview(result.pdf, "rendered");
    reportCompilePreview(result.pdf, "rendered");
    reportCompilePreview(new File(["manual"], "manual.pdf"), "rendered");
    await reportReady.promise;
    expect(reports).toHaveLength(1);
    const timing = previewTimingSchema.parse(reports[0]);
    expect(timing.outcome).toBe("rendered");
    expect(timing.actionToPdfMs).toBeGreaterThanOrEqual(0);
    expect(timing.keystrokeToPdfMs).not.toBeNull();
    if (timing.keystrokeToPdfMs === null)
      throw new Error("Missing edit timing");
    expect(timing.keystrokeToPdfMs - timing.actionToPdfMs).toBeCloseTo(100);
    expect(
      timing.submissionMs +
        timing.pollingMs +
        timing.downloadMs +
        timing.previewMs,
    ).toBeCloseTo(timing.actionToPdfMs, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preview failures and PDFs without edits remain distinct from keystroke samples", async () => {
  const originalFetch = globalThis.fetch;
  const report = Promise.withResolvers<unknown>();
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      report.resolve(JSON.parse(String(init?.body)));
      throw new Error("offline");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const file = new File(["pdf"], "output.pdf");
    trackCompilePreview({
      file,
      statusUrl: "/api/compile/project?job=id",
      startedAt: performance.now(),
      lastEditAt: null,
      submissionMs: 0,
      pollingMs: 0,
      downloadMs: 0,
    });
    reportCompilePreview(file, "preview_failed");
    expect(previewTimingSchema.parse(await report.promise)).toMatchObject({
      outcome: "preview_failed",
      keystrokeToPdfMs: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interactive compile waits for push without requesting status on a timer", async () => {
  const job = await compilation();
  job.source.message(snapshot(job.jobId, "queued"));
  job.source.message(snapshot(job.jobId, "running"));
  await Bun.sleep(1600);
  expect(job.reads).toBe(0);
  expect(job.settled).toBe(false);
  job.setStatus("succeeded");
  job.source.message(snapshot(job.jobId, "succeeded"));
  expect(await job.result).toMatchObject({
    jobId: job.jobId,
    log: "engine log",
  });
  expect(job.reads).toBe(1);
  expect(job.downloads).toBe(1);
});

test("pushed failure returns the engine error and log without downloading a PDF", async () => {
  const job = await compilation();
  job.setStatus("failed");
  job.source.message(snapshot(job.jobId, "failed"));
  expect(await job.result).toEqual({ error: "bad TeX", log: "engine log" });
  expect(job.reads).toBe(1);
  expect(job.downloads).toBe(0);
});

test("a dropped stream recovers a completed job with one status read", async () => {
  const job = await compilation();
  job.setStatus("succeeded");
  job.source.drop();
  job.source.drop();
  expect(await job.result).toMatchObject({ jobId: job.jobId });
  expect(job.reads).toBe(1);
});

test("a running recovery read waits for the reconnect snapshot and deduplicates repeated errors", async () => {
  const job = await compilation();
  job.source.drop();
  await Bun.sleep(0);
  job.source.drop();
  expect(job.reads).toBe(1);
  expect(job.settled).toBe(false);
  await job.source.reconnect();
  job.setStatus("succeeded");
  job.source.message(snapshot(job.jobId, "succeeded"));
  job.source.message(snapshot(job.jobId, "succeeded"));
  expect(await job.result).toMatchObject({ jobId: job.jobId });
  expect(job.reads).toBe(2);
  expect(job.downloads).toBe(1);
});

for (const failure of ["network", "server"] as const) {
  test(`reconnect still completes after a ${failure} recovery failure`, async () => {
    const job = await compilation();
    job.failRecovery(failure);
    job.source.drop();
    await Bun.sleep(0);
    expect(job.settled).toBe(false);
    job.failRecovery(null);
    await job.source.reconnect();
    job.setStatus("succeeded");
    job.source.message(snapshot(job.jobId, "succeeded"));
    expect(await job.result).toMatchObject({ jobId: job.jobId });
    expect(job.reads).toBe(2);
  });
}

test("latestBuild recovers a matching completion when current is absent", async () => {
  const job = await compilation();
  job.setStatus("succeeded");
  job.source.message({ ...snapshot(job.jobId, "succeeded"), current: null });
  expect(await job.result).toMatchObject({ jobId: job.jobId });
  expect(job.reads).toBe(1);
});

test("a newer job supersedes the waiter and late old completions cannot replace it", async () => {
  const job = await compilation();
  const newer = snapshot(crypto.randomUUID(), "running", 2);
  job.source.message(newer);
  job.source.message(snapshot(job.jobId, "succeeded"));
  expect(await job.result).toEqual({
    error: "Compilation superseded by a newer revision",
    log: "",
  });
  expect(job.reads).toBe(0);
  expect(job.downloads).toBe(0);
});

test("wrong job IDs and wrong revisions cannot resolve the active compile", async () => {
  const job = await compilation();
  job.source.message(snapshot(crypto.randomUUID(), "succeeded", 0));
  job.source.message(snapshot(job.jobId, "succeeded", 0));
  await Bun.sleep(0);
  expect(job.settled).toBe(false);
  expect(job.reads).toBe(0);
  job.setStatus("succeeded");
  job.source.message(snapshot(job.jobId, "succeeded"));
  expect(await job.result).toMatchObject({ jobId: job.jobId });
});

test("abort removes the waiter so later push and disconnect events do no work", async () => {
  const job = await compilation();
  job.controller.abort();
  await expect(job.result).rejects.toMatchObject({ name: "AbortError" });
  job.source.message(snapshot(job.jobId, "succeeded"));
  job.source.drop();
  expect(job.reads).toBe(0);
  expect(job.downloads).toBe(0);
});

test("a completion racing a running recovery response gets a fresh terminal read", async () => {
  const job = await compilation();
  const recovery = Promise.withResolvers<Response>();
  job.deferStatus(recovery.promise);
  job.source.drop();
  await job.source.reconnect();
  job.setStatus("succeeded");
  job.source.message(snapshot(job.jobId, "succeeded"));
  recovery.resolve(Response.json({ id: job.jobId, status: "running" }));
  job.deferStatus(
    Promise.resolve(
      Response.json({
        id: job.jobId,
        status: "succeeded",
        log: "done",
        artifactUrl: "/pdf",
      }),
    ),
  );
  expect(await job.result).toMatchObject({ jobId: job.jobId, log: "done" });
  expect(job.reads).toBe(2);
});

test("shared metadata permits retry queues but rejects older snapshots and terminal regressions", () => {
  const snapshots: BuildSnapshot[] = [];
  const { source, events } = openEvents((value) => snapshots.push(value));
  const id = crypto.randomUUID();
  source.message({ invalid: true });
  source.message(snapshot(id, "running", 2));
  source.message(snapshot(id, "queued", 2));
  source.message(snapshot(crypto.randomUUID(), "succeeded", 1));
  source.message(snapshot(id, "succeeded", 2));
  source.message(snapshot(id, "running", 2));
  expect(snapshots.map((value) => value.current?.status)).toEqual([
    "running",
    "queued",
    "succeeded",
  ]);
  events.close();
  expect(source.closed).toBe(true);
});

test("a lost socket reconnects until the stream is closed and reports each outage once", async () => {
  const snapshots: BuildSnapshot[] = [];
  const { events } = openEvents((value) => snapshots.push(value));
  const kinds: string[] = [];
  events.subscribe((event) => kinds.push(event.kind));
  const first = FakeSocket.latest;
  expect(first.url).toBe("/api/compile/project?events=1");
  source.message("pong");
  source.message(snapshot(crypto.randomUUID(), "running", 1));
  source.drop();
  source.drop();
  await source.reconnect();
  source.drop();
  await source.reconnect();
  // A late frame from a replaced socket is not this stream's any more.
  first.onmessage?.call(
    first as unknown as WebSocket,
    new MessageEvent("message", {
      data: JSON.stringify(snapshot(crypto.randomUUID(), "running", 9)),
    }),
  );
  source.message(snapshot(crypto.randomUUID(), "running", 2));
  source.drop();
  expect(kinds).toEqual([
    "snapshot",
    "disconnected",
    "snapshot",
    "disconnected",
  ]);
  expect(snapshots.map(({ revision }) => revision)).toEqual([1, 2]);
  const last = FakeSocket.latest;
  events.close();
  await Bun.sleep(700);
  expect(FakeSocket.latest).toBe(last);
});

test("superseding a job during its completion read prevents an old PDF download", async () => {
  const job = await compilation();
  const response = Promise.withResolvers<Response>();
  job.deferStatus(response.promise);
  job.source.message(snapshot(job.jobId, "succeeded"));
  job.source.message(snapshot(crypto.randomUUID(), "running", 2));
  response.resolve(
    Response.json({
      id: job.jobId,
      status: "succeeded",
      log: "old",
      artifactUrl: "/pdf",
    }),
  );
  expect(await job.result).toMatchObject({
    error: "Compilation superseded by a newer revision",
  });
  expect(job.downloads).toBe(0);
});

test("uncertain acceptance checks once and recovers the revision on completion", async () => {
  const job = await compilation(true);
  expect(job.reads).toBe(1);
  expect(job.settled).toBe(false);
  job.setStatus("succeeded");
  job.source.message(snapshot(job.jobId, "succeeded"));
  expect(await job.result).toMatchObject({ jobId: job.jobId, revision: 1 });
  expect(job.reads).toBe(2);
});

for (const status of [429, 503]) {
  test(`a ${status} submission ${status === 429 ? "is" : "is not"} reported as a usage limit`, async () => {
    const { events } = openEvents();
    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "Compile limit reached" }, { status }),
      { preconnect: originalFetch.preconnect },
    );
    const result = await requestCompilation({
      projectId: "project",
      events,
      mainFile: "main.tex",
      files: {},
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      error: "Compile limit reached",
      log: "",
      ...(status === 429 ? { limited: true } : {}),
    });
  });
}

test("terminal WS snapshots with log/error complete without an extra status GET", async () => {
  const { events, source } = openEvents();
  let jobId = "";
  let statusReads = 0;
  let pdfDownloads = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        jobId = new Headers(init.headers).get("X-Compilation-Id")!;
        return Response.json(
          {
            id: jobId,
            revision: 1,
            statusUrl: `/api/compile/project?job=${jobId}`,
            previewUrl: `/api/compile/project?job=${jobId}&preview=pdf`,
          },
          { status: 202 },
        );
      }
      if (url.includes("preview=pdf")) {
        pdfDownloads++;
        return new Response("%PDF-streamed", {
          headers: { "Content-Type": "application/pdf" },
        });
      }
      statusReads++;
      throw new Error(`Unexpected status read: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  const running = requestCompilation({
    projectId: "project",
    events,
    mainFile: "main.tex",
    files: {},
    signal: new AbortController().signal,
  });
  await Bun.sleep(0);
  const build = {
    id: jobId,
    revision: 1,
    status: "succeeded" as const,
    log: "direct ws log",
  };
  source.message({
    revision: 1,
    current: build,
    latestBuild: build,
    stale: false,
    artifacts: null,
  });
  const final = await running;
  expect(final).toMatchObject({ jobId, revision: 1, log: "direct ws log" });
  expect(statusReads).toBe(0);
  expect(pdfDownloads).toBe(1);
});
