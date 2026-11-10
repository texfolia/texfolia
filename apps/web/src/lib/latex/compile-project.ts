import { z } from "zod";

import { trackCompilePreview } from "./compile-telemetry";

const failure = z.object({ error: z.string(), log: z.string().optional() });
const submission = z.object({ id: z.uuid(), statusUrl: z.string() });
const status = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("running") }),
  z.object({
    status: z.literal("succeeded"),
    artifactUrl: z.string(),
    log: z.string(),
  }),
  z.object({ status: z.literal("failed"), error: z.string(), log: z.string() }),
]);

type CompileResult =
  | { pdf: File; log: string }
  | { error: string; log: string };

async function failureResult(response: Response): Promise<CompileResult> {
  const result = failure.safeParse(await response.json().catch(() => null));
  return {
    error: result.success ? result.data.error : "Compilation failed",
    log: result.success ? (result.data.log ?? "") : "",
  };
}

export async function requestCompilation(options: {
  projectId: string;
  mainFile: string;
  files: Record<string, string>;
  signal: AbortSignal;
  startedAt?: number;
  lastEditAt?: number | null;
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
      },
      body: JSON.stringify({ mainFile, files }),
      signal,
    },
  );
  if (!response.ok) return failureResult(response);
  const { id, statusUrl } = submission.parse(await response.json());
  if (id !== jobId) throw new Error("Invalid compiler job ID");
  const submittedAt = performance.now();
  let failures = 0;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    signal.throwIfAborted();
    const response = await fetch(statusUrl, { signal }).catch(
      (error: unknown) => {
        if (signal.aborted || ++failures >= 3) throw error;
        return null;
      },
    );
    if (!response) continue;
    if (response.status >= 500 && ++failures < 3) continue;
    if (!response.ok) return failureResult(response);
    failures = 0;
    const result = status.parse(await response.json());
    switch (result.status) {
      case "queued":
      case "running":
        continue;
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
        return { pdf: file, log: result.log };
      }
    }
  }
}
