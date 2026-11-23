import {
  acceptedJobSchema,
  buildSnapshotSchema,
  compileJobSchema,
  previewTimingSchema,
  type JobTiming,
} from "@texfolia/contracts";
import type { Db } from "@texfolia/db";
import { projectJob } from "@texfolia/db/schema";
import { streamProjectResponse } from "@texfolia/projects/server";
import { env } from "cloudflare:workers";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { createAuth } from "#/lib/auth";
import { compilePlan } from "#/lib/billing.server";
import { withCompileSources } from "#/lib/compile-source.server";
import {
  compileHistoryLimit,
  sessionElapsedSchema,
  sessionHistoryLimit,
  sessionHistoryParam,
  timelineRetentionMs,
} from "#/lib/compile/compile-history";
import { compileDeltaSchema, hashSource } from "#/lib/compile/source-sync";
import { fetchCompiler } from "#/lib/compiler.server";
import { lockProject } from "#/lib/project-access.server";
import { requestPrincipal } from "#/lib/request-principal.server";

const idSchema = z.uuid();
const failure = z.object({ error: z.string(), log: z.string().optional() });
const maxBytes = 10 * 1024 * 1024;
const noStore = { "Cache-Control": "no-store" };

function json(data: unknown, status = 200, headers: HeadersInit = noStore) {
  return Response.json(data, { status, headers });
}

function submissionResponse({
  id,
  projectId,
  revision,
  sourceRevision,
  serverMs,
}: {
  id: string;
  projectId: string;
  revision?: number;
  sourceRevision?: number;
  serverMs?: number;
}) {
  const statusUrl = `/api/compile/${projectId}?job=${id}`;
  return json(
    {
      id,
      revision,
      sourceRevision,
      // Lets the browser subtract route processing from its round trip when it
      // maps its own measurements onto receivedAt.
      serverMs,
      status: "queued",
      statusUrl,
      previewUrl: `${statusUrl}&preview=pdf`,
    },
    202,
    { ...noStore, Location: statusUrl, "Retry-After": "1" },
  );
}

function compileRequestDigest({
  request,
  projectId,
  userId,
  body,
}: {
  request: Request;
  projectId: string;
  userId: string;
  body: z.infer<typeof compileDeltaSchema>;
}) {
  return hashSource(
    new TextEncoder().encode(
      JSON.stringify({
        projectId,
        userId,
        clean: request.headers.get("X-Clean-Build") === "1",
        metadata: request.headers.get("X-Source-Metadata") ?? "",
        editorId: request.headers.get("X-Editor-Id"),
        editorSequence: request.headers.get("X-Editor-Sequence"),
        mainFile: body.mainFile,
        baseRevision: body.baseRevision,
        revision: body.revision,
        files: Object.keys(body.files)
          .sort()
          .map((path) => [path, body.files[path]]),
        deleted: [...body.deleted].sort(),
      }),
    ),
  );
}

async function checkProject(
  request: Request,
  projectId: string,
  { auth, db }: { auth: ReturnType<typeof createAuth>; db: Db },
) {
  const principal = await requestPrincipal({ request, auth, db, projectId });
  if (!principal) return json({ error: "Unauthorized" }, 401);
  if (!idSchema.safeParse(projectId).success)
    return json({ error: "Project not found" }, 404);
  // Share links only read builds; they never submit work or report telemetry.
  if (principal.share && request.method !== "GET")
    return json({ error: "Project not found" }, 404);
  let shareScope: "project" | "pdf" | null;
  try {
    ({ shareScope } = await db.transaction((tx) =>
      lockProject({
        tx,
        projectId,
        userId: principal.userId,
        access:
          request.method === "GET" || request.method === "PATCH"
            ? "read"
            : "write",
        content: "build",
      }),
    ));
  } catch (error) {
    if (error instanceof Error && error.message === "Project not found")
      return json({ error: "Project not found" }, 404);
    throw error;
  }
  return { userId: principal.userId, name: principal.name, shareScope };
}

async function readSources(request: Request) {
  const reader = request.body?.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  while (reader) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maxBytes) {
      await reader.cancel();
      return json({ error: "Project exceeds 10 MiB" }, 413);
    }
    chunks.push(new Uint8Array(value));
  }
  const body = await new Blob(chunks).text();
  try {
    return compileDeltaSchema.parse(JSON.parse(body));
  } catch {
    return json({ error: "Invalid project sources" }, 400);
  }
}

function updateJob(
  db: Db,
  id: string,
  values: PgUpdateSetSource<typeof projectJob>,
) {
  return db
    .update(projectJob)
    .set(values)
    .where(
      and(
        eq(projectJob.id, id),
        inArray(projectJob.status, ["queued", "running"]),
      ),
    );
}

// Adds top-level keys to the job timeline without replacing other parts.
function mergeTiming(value: Record<string, unknown>) {
  return sql`coalesce(${projectJob.timing}, '{}'::jsonb) || ${JSON.stringify(value)}::jsonb`;
}

function compilerTimeline(result: { createdAt?: string; timing?: JobTiming }) {
  return { compiler: { ...result.timing, acceptedAt: result.createdAt } };
}

// Recent compiles keep a timeline so the Logs tab can show a whole editing
// session; older rows remain for accounting.
async function pruneTimelines(db: Db, projectId: string) {
  const latest = (limit: number) =>
    db
      .select({ id: projectJob.id })
      .from(projectJob)
      .where(eq(projectJob.projectId, projectId))
      .orderBy(desc(projectJob.createdAt))
      .limit(limit);
  await db
    .update(projectJob)
    .set({ timing: null })
    .where(
      and(
        eq(projectJob.projectId, projectId),
        isNotNull(projectJob.timing),
        notInArray(projectJob.id, latest(compileHistoryLimit)),
        or(
          lt(projectJob.createdAt, new Date(Date.now() - timelineRetentionMs)),
          notInArray(projectJob.id, latest(sessionHistoryLimit)),
        ),
      ),
    );
}

// The job row and the server clock can disagree slightly, so the session
// includes compiles created just before the editor opened.
const sessionClockSlackMs = 5_000;

async function finishJob(
  db: Db,
  projectId: string,
  id: string,
  values: PgUpdateSetSource<typeof projectJob>,
) {
  const updated = await updateJob(db, id, values).returning({
    id: projectJob.id,
  });
  if (updated.length)
    await pruneTimelines(db, projectId).catch((error: unknown) => {
      console.error("Compile timeline pruning failed", { projectId, error });
    });
}

async function readPreviewBody(request: Request) {
  const text = await readLimitedBody(request);
  if (text === null) return null;
  try {
    return z
      .object({ editorId: z.uuid(), sequence: z.number().int().nonnegative() })
      .parse(JSON.parse(text));
  } catch {
    return null;
  }
}

async function readLimitedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      return null;
    }
    chunks.push(new Uint8Array(value));
  }
  return new Blob(chunks).text();
}

async function readPreviewTiming(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      return null;
    }
    chunks.push(new Uint8Array(value));
  }
  try {
    const parsed = previewTimingSchema.safeParse(
      JSON.parse(await new Blob(chunks).text()),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function isLatestPdf(projectId: string, path: string) {
  const response = await fetchCompiler(`/projects/${projectId}`);
  if (!response.ok) return false;
  const snapshot = buildSnapshotSchema.safeParse(
    await response.json().catch(() => null),
  );
  return (
    snapshot.success &&
    snapshot.data.artifacts?.pdf != null &&
    snapshot.data.artifacts.pdf === path
  );
}

type CompileArgs = {
  request: Request;
  params: { projectId: string };
  context: { db: Db; auth: ReturnType<typeof createAuth> };
};

export const compileHandlers = {
  POST: async ({ request, params, context }: CompileArgs) => {
    const started = performance.now();
    const receivedAt = new Date().toISOString();
    const { db } = context;
    const denied = await checkProject(request, params.projectId, context);
    if (denied instanceof Response) return denied;
    if (new URL(request.url).searchParams.get("changed") === "1") {
      const body = await readPreviewBody(request);
      if (!body) return json({ error: "Invalid editor revision" }, 400);
      return fetchCompiler(`/projects/${params.projectId}/changed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (!request.headers.get("Content-Type")?.startsWith("application/json"))
      return json({ error: "Expected application/json" }, 415);
    const body = await readSources(request);
    if (body instanceof Response) return body;

    const id =
      idSchema.safeParse(request.headers.get("X-Compilation-Id")).data ??
      crypto.randomUUID();
    const requestDigest = await compileRequestDigest({
      request,
      projectId: params.projectId,
      userId: denied.userId,
      body,
    });
    const plan = await compilePlan(db, denied.userId);
    const [reserved] = await db
      .insert(projectJob)
      .values({
        id,
        projectId: params.projectId,
        requestDigest,
        status: "queued",
        sizeBytes: 0n,
        timing: { web: { receivedAt } },
      })
      .onConflictDoNothing({ target: projectJob.id })
      .returning({ id: projectJob.id });
    if (!reserved) {
      const existing = await db.query.projectJob.findFirst({
        columns: { id: true },
        where: { id, projectId: params.projectId, requestDigest },
      });
      if (!existing) return json({ error: "Compilation ID already used" }, 409);
      // The reserving request owns submission, even while its response is
      // uncertain. Reconcile through GET without resubmitting newer sources.
      return submissionResponse({ id, projectId: params.projectId });
    }

    let submitted = false;
    let revision: number | undefined;
    let sourceRevision: number | undefined;
    try {
      const send = (sources: object) => {
        submitted = true;
        return fetchCompiler(`/projects/${params.projectId}/compile`, {
          method: "POST",
          // Source synchronization can outlast the default 15-second timeout.
          signal: request.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Compilation-Id": id,
            "X-Compile-Plan": plan,
            "X-Compile-User": denied.userId,
            "X-Build-User": encodeURIComponent(denied.name),
            "X-Clean-Build":
              request.headers.get("X-Clean-Build") === "1" ? "1" : "0",
            ...(request.headers.has("X-Editor-Id") ||
            request.headers.has("X-Editor-Sequence")
              ? {
                  "X-Editor-Id": request.headers.get("X-Editor-Id") ?? "",
                  "X-Editor-Sequence":
                    request.headers.get("X-Editor-Sequence") ?? "",
                }
              : {}),
          },
          body: JSON.stringify(sources),
        });
      };
      // Keep metadata writes behind the project lock until the compiler
      // accepts this snapshot. Later changes then invalidate that build.
      let response = await withCompileSources({
        db,
        bucket: env.SOURCES,
        projectId: params.projectId,
        userId: denied.userId,
        mainFile: body.mainFile,
        sourceRevision: body.baseRevision,
        client: {
          version: request.headers.get("X-Source-Metadata") ?? "",
          delta: body,
        },
        submit: send,
      });
      if (response.status === 409) {
        const resync = z
          .object({
            resync: z.literal(true),
            sourceRevision: z.number().int().nonnegative(),
          })
          .safeParse(
            await response
              .clone()
              .json()
              .catch(() => null),
          );
        if (resync.success) {
          submitted = false;
          response = await withCompileSources({
            db,
            bucket: env.SOURCES,
            projectId: params.projectId,
            userId: denied.userId,
            mainFile: body.mainFile,
            sourceRevision: resync.data.sourceRevision,
            submit: send,
          });
        }
      }
      if (response.status === 202) {
        const accepted = acceptedJobSchema.parse(await response.json());
        if (accepted.id !== id) throw new Error("Invalid compiler job ID");
        revision = accepted.revision;
        sourceRevision = accepted.sourceRevision;
        if (accepted.supersededId)
          await db
            .update(projectJob)
            .set({
              status: "failed",
              error: "Compilation superseded by a newer revision",
              finishedAt: new Date(),
            })
            .where(
              and(
                eq(projectJob.projectId, params.projectId),
                eq(projectJob.id, accepted.supersededId),
                inArray(projectJob.status, ["queued", "running"]),
              ),
            );
      } else if (response.status < 500) {
        const parsed = failure.safeParse(
          await response.json().catch(() => null),
        );
        const detail = parsed.success
          ? parsed.data
          : { error: "Compilation service failed" };
        await updateJob(db, id, {
          ...detail,
          status: "failed",
          finishedAt: new Date(),
        });
        const headers = new Headers(noStore);
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter) headers.set("Retry-After", retryAfter);
        console.info({
          telemetryVersion: 1,
          event: "compile_web_submission",
          jobId: id,
          plan,
          outcome: "rejected",
          submissionMs: performance.now() - started,
        });
        return json(detail, response.ok ? 502 : response.status, headers);
      } else {
        throw new Error(`Compiler submission returned ${response.status}`);
      }
    } catch (error) {
      if (!submitted) {
        const message =
          error instanceof Error
            ? error.message
            : "Source synchronization failed";
        await updateJob(db, id, {
          status: "failed",
          error: message,
          finishedAt: new Date(),
        });
        return json(
          { error: message },
          message === "Project not found" ? 404 : 409,
        );
      }
      // A lost response can follow a successful submission. Let the client
      // check the reserved ID before asking the user to submit new work.
      console.error("Compile submission response failed", {
        jobId: id,
        error,
      });
    }
    console.info({
      telemetryVersion: 1,
      event: "compile_web_submission",
      jobId: id,
      plan,
      submissionMs: performance.now() - started,
    });
    return submissionResponse({
      id,
      projectId: params.projectId,
      revision,
      sourceRevision,
      serverMs: performance.now() - started,
    });
  },
  PATCH: async ({ request, params, context }: CompileArgs) => {
    const denied = await checkProject(request, params.projectId, context);
    if (denied instanceof Response) return denied;
    const id = idSchema.safeParse(new URL(request.url).searchParams.get("job"));
    if (!id.success) return json({ error: "Job not found" }, 404);
    const job = await context.db.query.projectJob.findFirst({
      columns: { id: true, status: true },
      where: { id: id.data, projectId: params.projectId },
    });
    if (!job || !["succeeded", "failed"].includes(job.status))
      return json({ error: "Job not found" }, 404);
    const body = await readPreviewTiming(request);
    if (!body) return json({ error: "Invalid preview timing" }, 400);
    let timing: JobTiming | undefined;
    try {
      const response = await fetchCompiler(
        `/projects/${params.projectId}/jobs/${id.data}`,
      );
      const result = compileJobSchema.safeParse(await response.json());
      if (
        result.success &&
        result.data.id === id.data &&
        (result.data.status === "succeeded" || result.data.status === "failed")
      )
        timing = result.data.timing;
    } catch {
      /* Preview reporting must not affect compilation. */
    }
    // Persist the first report for the Logs timeline. Pruned or older jobs
    // have no timeline to extend.
    await context.db
      .update(projectJob)
      .set({ timing: mergeTiming({ client: body }) })
      .where(
        and(
          eq(projectJob.id, id.data),
          eq(projectJob.projectId, params.projectId),
          isNotNull(projectJob.timing),
          sql`${projectJob.timing} -> 'client' is null`,
        ),
      );
    console.info({
      ...timing,
      ...body,
      telemetryVersion: 1,
      event: "compile_preview",
      jobId: id.data,
      source: "browser",
    });
    return new Response(null, { status: 204, headers: noStore });
  },
  GET: async ({ request, params, context }: CompileArgs) => {
    const { db } = context;
    const denied = await checkProject(request, params.projectId, context);
    if (denied instanceof Response) return denied;
    const url = new URL(request.url);
    const liveResponse = (response: Response) =>
      streamProjectResponse({
        response,
        connectionString: env.HYPERDRIVE.connectionString,
        projectId: params.projectId,
        userId: denied.userId,
        signal: request.signal,
        lock: lockProject,
      });
    // PDF-only links see the build stream and the latest PDF, but not job
    // logs or other generated files, which can quote the sources.
    const pdfOnly = denied.shareScope === "pdf";
    if (url.searchParams.get("history") === "1") {
      if (pdfOnly) return json({ error: "Not found" }, 404);
      const session = url.searchParams.has(sessionHistoryParam)
        ? sessionElapsedSchema.safeParse(
            url.searchParams.get(sessionHistoryParam),
          )
        : null;
      if (session && !session.success)
        return json({ error: "Invalid session" }, 400);
      const since = session
        ? new Date(Date.now() - session.data - sessionClockSlackMs)
        : null;
      const limit = since ? sessionHistoryLimit : compileHistoryLimit;
      const jobs = await db
        .select({
          id: projectJob.id,
          status: projectJob.status,
          error: projectJob.error,
          createdAt: projectJob.createdAt,
          startedAt: projectJob.startedAt,
          finishedAt: projectJob.finishedAt,
          timing: projectJob.timing,
        })
        .from(projectJob)
        .where(
          and(
            eq(projectJob.projectId, params.projectId),
            since ? gte(projectJob.createdAt, since) : undefined,
          ),
        )
        .orderBy(desc(projectJob.createdAt))
        .limit(limit + 1);
      return json({
        jobs: jobs.slice(0, limit),
        truncated: jobs.length > limit,
      });
    }
    if (!url.searchParams.has("job")) {
      try {
        const file = url.searchParams.get("file");
        if (
          file !== null &&
          pdfOnly &&
          !(await isLatestPdf(params.projectId, file))
        )
          return json({ error: "File not found" }, 404);
        if (file !== null)
          return await fetchCompiler(
            `/projects/${params.projectId}/build/files?path=${encodeURIComponent(file)}&version=${encodeURIComponent(url.searchParams.get("version") ?? "")}`,
          );
        const events = url.searchParams.get("events") === "1";
        const response = await fetchCompiler(
          `/projects/${params.projectId}${events ? "/events" : ""}`,
          events ? { signal: request.signal } : undefined,
        );
        return events ? liveResponse(response) : response;
      } catch {
        return json({ error: "Project coordinator unavailable" }, 502);
      }
    }
    const parsedId = idSchema.safeParse(url.searchParams.get("job"));
    if (!parsedId.success || pdfOnly)
      return json({ error: "Job not found" }, 404);
    const id = parsedId.data;
    const job = await db.query.projectJob.findFirst({
      columns: { id: true, status: true, createdAt: true },
      where: { id, projectId: params.projectId },
    });
    if (!job) return json({ error: "Job not found" }, 404);
    if (url.searchParams.get("log") === "1") {
      const row = await db.query.projectJob.findFirst({
        columns: { log: true },
        where: { id, projectId: params.projectId },
      });
      return json({ id, status: job.status, log: row?.log ?? "" });
    }
    const pdfPath = `/projects/${params.projectId}/compilations/${id}.pdf`;
    try {
      if (url.searchParams.get("preview") === "pdf") {
        const response = await fetchCompiler(
          `/projects/${params.projectId}/jobs/${id}/pdf`,
          {
            signal: AbortSignal.any([
              request.signal,
              AbortSignal.timeout(10 * 60_000),
            ]),
          },
        );
        if (!response.ok) return response;
        if (response.headers.get("Content-Type") !== "application/pdf")
          throw new Error("Invalid compiler PDF stream");
        return liveResponse(
          new Response(response.body, {
            headers: {
              ...noStore,
              "Content-Type": "application/pdf",
              "X-Accel-Buffering": "no",
            },
          }),
        );
      }
      if (url.searchParams.get("artifact") === "pdf") {
        if (job.status !== "succeeded")
          return json({ error: "PDF not found" }, 404);
        const pdf = await fetchCompiler(pdfPath);
        if (pdf.status === 404) return json({ error: "PDF not found" }, 404);
        if (!pdf.ok || pdf.headers.get("Content-Type") !== "application/pdf")
          throw new Error("Invalid compiler PDF response");
        return new Response(pdf.body, {
          headers: { ...noStore, "Content-Type": "application/pdf" },
        });
      }

      const response = await fetchCompiler(
        `/projects/${params.projectId}/jobs/${id}`,
      );
      if (response.status === 404) {
        if (Date.now() - job.createdAt.getTime() < 30_000)
          return json({ id, status: "queued" }, 200, {
            ...noStore,
            "Retry-After": "1",
          });
        const error = "The compiler did not receive this job. Try again.";
        await updateJob(db, id, {
          status: "failed",
          error,
          finishedAt: new Date(),
        });
        return json({ id, status: "failed", error, log: "" });
      }
      if (!response.ok)
        throw new Error(`Compiler status returned ${response.status}`);
      const result = compileJobSchema.parse(await response.json());
      if (result.id !== id) throw new Error("Invalid compiler job ID");
      switch (result.status) {
        case "queued":
        case "running":
          if (result.status === "running" && job.status === "queued") {
            await db
              .update(projectJob)
              .set({ status: "running", startedAt: new Date() })
              .where(
                and(eq(projectJob.id, id), eq(projectJob.status, "queued")),
              );
          }
          return json(result, 200, { ...noStore, "Retry-After": "1" });
        case "succeeded":
          if (result.artifactUrl !== pdfPath)
            throw new Error("Invalid compiler artifact URL");
          await finishJob(db, params.projectId, id, {
            status: "succeeded",
            log: result.log,
            objectKey: pdfPath.slice(1),
            sizeBytes: BigInt(result.sizeBytes),
            finishedAt: new Date(),
            timing: mergeTiming(compilerTimeline(result)),
          });
          return json({
            ...result,
            artifactUrl: `/api/compile/${params.projectId}?job=${id}&artifact=pdf`,
          });
        case "failed": {
          await finishJob(db, params.projectId, id, {
            status: "failed",
            error: result.error,
            log: result.log,
            finishedAt: new Date(),
            timing: mergeTiming(compilerTimeline(result)),
          });
          return json(result);
        }
      }
    } catch (error) {
      console.error("Compile status or artifact fetch failed", {
        jobId: id,
        error,
      });
      return json({ error: "Compilation service failed" }, 502);
    }
  },
};

export const handleCompilePost = compileHandlers.POST;
export const handleCompileGet = compileHandlers.GET;
