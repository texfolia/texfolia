import { z } from "zod";

import type { SourceFiles } from "../project-source";
import { trackCompilePreview } from "./compile-telemetry";
import type { ProjectBuildEvents } from "./project-build-events";

const failure = z.object({ error: z.string(), log: z.string().optional() });
const submission = z.object({
  id: z.uuid(),
  revision: z.number().int().nonnegative().optional(),
  statusUrl: z.string(),
});
const status = z.discriminatedUnion("status", [
  z.object({ id: z.uuid(), status: z.literal("queued") }),
  z.object({ id: z.uuid(), status: z.literal("running") }),
  z.object({
    id: z.uuid(),
    status: z.literal("succeeded"),
    revision: z.number().int().nonnegative().optional(),
    artifactUrl: z.string(),
    log: z.string(),
  }),
  z.object({
    id: z.uuid(),
    status: z.literal("failed"),
    error: z.string(),
    log: z.string(),
  }),
]);

type CompileResult =
  | { pdf: File; log: string; jobId: string; revision: number | undefined }
  | { error: string; log: string };

async function failureResult(response: Response) {
  const result = failure.safeParse(await response.json().catch(() => null));
  return {
    error: result.success ? result.data.error : "Compilation failed",
    log: result.success ? (result.data.log ?? "") : "",
  };
}

type TerminalStatus = Extract<
  z.infer<typeof status>,
  { status: "succeeded" | "failed" }
>;

function waitForCompletion(options: {
  events: ProjectBuildEvents;
  jobId: string;
  revision?: number;
  statusUrl: string;
  signal: AbortSignal;
}): Promise<TerminalStatus> {
  const { events, jobId, statusUrl, signal } = options;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let revision = options.revision;
    let settled = false;
    let checking = false;
    let terminalNotified = false;
    let unsubscribe = () => {};
    const cleanup = () => {
      settled = true;
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    const finish = (result: TerminalStatus) => {
      if (settled) return;
      cleanup();
      resolve(result);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    // A terminal notification reconciles the web job record before PDF access.
    // During an outage, make one recovery read and otherwise await SSE reconnect.
    const check = async () => {
      if (checking || settled) return;
      checking = true;
      const completing = terminalNotified;
      try {
        const response = await fetch(statusUrl, { signal });
        if (!response.ok) {
          if (!terminalNotified && response.status >= 500) return;
          const result = await failureResult(response);
          finish({ id: jobId, status: "failed", ...result });
          return;
        }
        const result = status.parse(await response.json());
        if (result.id !== jobId) throw new Error("Invalid compiler job ID");
        if (result.status === "succeeded" || result.status === "failed")
          finish(result);
        else if (completing) {
          cleanup();
          reject(
            new Error("Compiler status did not match its completion event"),
          );
        }
      } catch (error) {
        if (!settled && (terminalNotified || signal.aborted)) {
          cleanup();
          reject(error);
        }
      } finally {
        checking = false;
        if (!settled && !completing && terminalNotified) void check();
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    unsubscribe = events.subscribe((event) => {
      if (settled) return;
      if (event.kind === "disconnected") {
        void check();
        return;
      }
      const { current, latestBuild } = event.snapshot;
      const matching = [current, latestBuild].find(
        (build) => build?.id === jobId,
      );
      if (matching) {
        if (revision !== undefined && matching.revision !== revision) return;
        revision = matching.revision;
      }
      if (
        current &&
        current.id !== jobId &&
        revision !== undefined &&
        current.revision > revision
      ) {
        finish({
          id: jobId,
          status: "failed",
          error: "Compilation superseded by a newer revision",
          log: "",
        });
        return;
      }
      if (matching?.status === "succeeded" || matching?.status === "failed") {
        terminalNotified = true;
        void check();
      }
    });
    if (settled) unsubscribe();
    // An uncertain submission has no accepted revision to await in the stream.
    if (options.revision === undefined) void check();
  });
}

export async function requestCompilation(options: {
  projectId: string;
  events: ProjectBuildEvents;
  mainFile: string;
  files: SourceFiles;
  signal: AbortSignal;
  startedAt?: number;
  lastEditAt?: number | null;
  clean?: boolean;
  editorVersion?: { editorId: string; sequence: number };
}): Promise<CompileResult> {
  const { projectId, mainFile, files, signal } = options;
  const startedAt = options.startedAt ?? performance.now();
  const jobId = crypto.randomUUID();
  const response = await fetch(
    `/api/compile/${encodeURIComponent(projectId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Compilation-Id": jobId,
        "X-Clean-Build": options.clean ? "1" : "0",
        ...(options.editorVersion
          ? {
              "X-Editor-Id": options.editorVersion.editorId,
              "X-Editor-Sequence": String(options.editorVersion.sequence),
            }
          : {}),
      },
      body: JSON.stringify({ mainFile, files }),
      signal,
    },
  );
  if (!response.ok) return failureResult(response);
  const { id, revision, statusUrl } = submission.parse(await response.json());
  if (id !== jobId) throw new Error("Invalid compiler job ID");
  const submittedAt = performance.now();
  const result = await waitForCompletion({
    events: options.events,
    jobId,
    revision,
    statusUrl,
    signal,
  });
  signal.throwIfAborted();
  switch (result.status) {
    case "failed":
      return { error: result.error, log: result.log };
    case "succeeded": {
      const downloadAt = performance.now();
      const pdf = await fetch(result.artifactUrl, { signal });
      if (!pdf.ok) return failureResult(pdf);
      const file = new File([await pdf.blob()], "output.pdf", {
        type: "application/pdf",
      });
      trackCompilePreview({
        file,
        statusUrl,
        startedAt,
        lastEditAt: options.lastEditAt ?? null,
        submissionMs: submittedAt - startedAt,
        pollingMs: downloadAt - submittedAt,
        downloadMs: performance.now() - downloadAt,
      });
      return {
        pdf: file,
        log: result.log,
        jobId,
        revision: result.revision ?? revision,
      };
    }
  }
}
