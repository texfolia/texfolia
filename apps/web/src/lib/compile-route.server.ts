import type { Db } from "@texfolia/db";
import { projectJob } from "@texfolia/db/schema";
import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { createAuth } from "#/lib/auth";
import { compilePlan } from "#/lib/billing.server";
import { withCompileSources } from "#/lib/compile-source.server";
import { fetchCompiler } from "#/lib/compiler.server";
import { previewTimingSchema } from "#/lib/latex/compile-telemetry";
import { compileDeltaSchema, hashSource } from "#/lib/latex/source-sync";
import { streamProjectResponse } from "#/lib/live-project.server";
import { lockProject } from "#/lib/project-access.server";

const compilerTimingSchema = z.looseObject({
  plan: z.enum(["free", "pro", "team", "unknown"]),
  engine: z.enum(["tectonic", "texlive", "unknown"]),
  temperature: z.enum(["cold", "warm", "unknown"]),
});
type CompilerTiming = z.infer<typeof compilerTimingSchema>;

const idSchema = z.uuid();
const pending = z.object({
  id: idSchema,
  status: z.enum(["queued", "running"]),
  supersededId: idSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
  sourceRevision: z.number().int().nonnegative().optional(),
});
const status = z.union([
  pending,
  z.object({
    id: idSchema,
    status: z.literal("succeeded"),
    artifactUrl: z.string(),
    sizeBytes: z
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024),
    log: z.string(),
    timing: compilerTimingSchema.optional(),
  }),
  z.object({
    id: idSchema,
    status: z.literal("failed"),
    error: z.string(),
    log: z.string(),
    timing: compilerTimingSchema.optional(),
  }),
]);
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
}: {
  id: string;
  projectId: string;
  revision?: number;
  sourceRevision?: number;
}) {
  const statusUrl = `/api/compile/${projectId}?job=${id}`;
  return json(
    {
      id,
      revision,
      sourceRevision,
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
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return json({ error: "Unauthorized" }, 401);
  if (!idSchema.safeParse(projectId).success)
    return json({ error: "Project not found" }, 404);
  try {
    await db.transaction((tx) =>
      lockProject({
        tx,
        projectId,
        userId: session.user.id,
        access:
          request.method === "GET" || request.method === "PATCH"
            ? "read"
            : "write",
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Project not found")
      return json({ error: "Project not found" }, 404);
    throw error;
  }
  return { userId: session.user.id, name: session.user.name };
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
  values: Partial<typeof projectJob.$inferInsert>,
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

type CompileArgs = {
  request: Request;
  params: { projectId: string };
  context: { db: Db; auth: ReturnType<typeof createAuth> };
};

export const compileHandlers = {
  POST: async ({ request, params, context }: CompileArgs) => {
    const started = performance.now();
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
        const accepted = pending.parse(await response.json());
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
    let timing: CompilerTiming | undefined;
    try {
      const response = await fetchCompiler(
        `/projects/${params.projectId}/jobs/${id.data}`,
      );
      const result = status.safeParse(await response.json());
      if (
        result.success &&
        result.data.id === id.data &&
        (result.data.status === "succeeded" || result.data.status === "failed")
      )
        timing = result.data.timing;
    } catch {
      /* Preview reporting must not affect compilation. */
    }
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
      });
    if (!url.searchParams.has("job")) {
      try {
        const file = url.searchParams.get("file");
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
    if (!parsedId.success) return json({ error: "Job not found" }, 404);
    const id = parsedId.data;
    const job = await db.query.projectJob.findFirst({
      columns: { id: true, status: true, createdAt: true },
      where: { id, projectId: params.projectId },
    });
    if (!job) return json({ error: "Job not found" }, 404);
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
        let pdf = await fetchCompiler(pdfPath);
        if (pdf.status === 404)
          pdf = await fetchCompiler(`/compilations/${id}.pdf`);
        if (pdf.status === 404) return json({ error: "PDF not found" }, 404);
        if (!pdf.ok || pdf.headers.get("Content-Type") !== "application/pdf")
          throw new Error("Invalid compiler PDF response");
        return new Response(pdf.body, {
          headers: { ...noStore, "Content-Type": "application/pdf" },
        });
      }

      let response = await fetchCompiler(
        `/projects/${params.projectId}/jobs/${id}`,
      );
      // Retain access to jobs submitted before project coordination shipped.
      if (response.status === 404)
        response = await fetchCompiler(`/jobs/${id}`);
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
      const result = status.parse(await response.json());
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
          if (
            result.artifactUrl !== pdfPath &&
            result.artifactUrl !== `/compilations/${id}.pdf`
          )
            throw new Error("Invalid compiler artifact URL");
          await updateJob(db, id, {
            status: "succeeded",
            log: result.log,
            objectKey: pdfPath.slice(1),
            sizeBytes: BigInt(result.sizeBytes),
            finishedAt: new Date(),
          });
          return json({
            ...result,
            artifactUrl: `/api/compile/${params.projectId}?job=${id}&artifact=pdf`,
          });
        case "failed":
          await updateJob(db, id, {
            status: "failed",
            error: result.error,
            log: result.log,
            finishedAt: new Date(),
          });
          return json(result);
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
