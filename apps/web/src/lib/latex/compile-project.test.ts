import { expect, test } from "bun:test";

import { requestCompilation } from "./compile-project";
import {
  previewTimingSchema,
  reportCompilePreview,
  trackCompilePreview,
} from "./compile-telemetry";

test("submission carries the browser job ID and preview reports only once after rendering", async () => {
  const originalFetch = globalThis.fetch;
  const reports: unknown[] = [];
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
          files: { "main.tex": "hello" },
        });
        return Response.json(
          { id: jobId, statusUrl: `/api/compile/project?job=${jobId}` },
          { status: 202 },
        );
      }
      if (request.method === "PATCH") {
        expect(new URL(request.url).searchParams.get("job")).toBe(jobId);
        reports.push(await request.json());
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
    await Promise.resolve();
    expect(reports).toHaveLength(1);
    const timing = previewTimingSchema.parse(reports[0]);
    expect(timing.outcome).toBe("rendered");
    expect(timing.actionToPdfMs).toBeGreaterThanOrEqual(1500);
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
