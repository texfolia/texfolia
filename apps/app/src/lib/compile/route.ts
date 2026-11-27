import {
  acceptedJobSchema,
  compileJobSchema,
  previewTimingSchema,
} from "@texfolia/contracts";
import type { Db } from "@texfolia/db";
import { projectJob } from "@texfolia/db/schema";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  connectBuilds,
  fetchBuilds,
  invalidateSourceBuild,
  immutableArtifact,
  liveUserHeader,
} from "#/lib/builds/client";
import {
  mergeJobTiming,
  reconcileProjectJob,
  updateProjectJob,
} from "#/lib/builds/job-persistence.server";

import {
  compileHistoryLimit,
  parseJobTimeline,
  sessionElapsedSchema,
  sessionHistoryLimit,
  sessionHistoryParam,
} from "./compile-history";
import { compileDeltaSchema, hashSource } from "./source-sync";
import { createCompileSources, type CompileProject } from "./sources";

export type CompilePrincipal = {
  userId: string;
  name: string;
  // Share-link principals only read builds.
  share: boolean;
};

export type CompileRouteOptions<Context extends { db: Db }> = {
  // Resolves the signed-in user or share link. Return null when neither is
  // present.
  principal(options: {
    request: Request;
    projectId: string;
    context: Context;
  }): Promise<CompilePrincipal | null>;
  project: CompileProject;
  // The billing plan the build is admitted and limited by.
  compilePlan(db: Db, userId: string): Promise<string>;
};

export type CompileHandlerArgs<Context extends { db: Db }> = {
  request: Request;
  params: { projectId: string };
  context: Context;
};

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

async function resolveAuthorizedPrincipal<Context extends { db: Db }>(
  request: Request,
  projectId: string,
  context: Context,
  { principal: resolvePrincipal }: CompileRouteOptions<Context>,
) {
  const principal = await resolvePrincipal({ request, projectId, context });
  if (!principal) return json({ error: "Unauthorized" }, 401);
  if (!idSchema.safeParse(projectId).success)
    return json({ error: "Project not found" }, 404);
  // Share links only read builds; they never submit work or report telemetry.
  if (principal.share && request.method !== "GET")
    return json({ error: "Project not found" }, 404);
  return { userId: principal.userId, name: principal.name };
}

async function checkProject<Context extends { db: Db }>(
  request: Request,
  projectId: string,
  context: Context,
  options: CompileRouteOptions<Context>,
) {
  const principal = await resolveAuthorizedPrincipal(
    request,
    projectId,
    context,
    options,
  );
  if (principal instanceof Response) return principal;
  try {
    await context.db.transaction((tx) =>
      options.project.lock({
        tx,
        projectId,
        userId: principal.userId,
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
  return principal;
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

// The job row and the server clock can disagree slightly, so the session
// includes compiles created just before the editor opened.
const sessionClockSlackMs = 5_000;

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
  const text = await readLimitedBody(request);
  if (text === null) return null;
  try {
    const parsed = previewTimingSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Handlers for `/api/compile/$projectId`. The app supplies authentication,
// the project aggregate, billing, and live-stream wiring.
export function createCompileHandlers<Context extends { db: Db }>(
  options: CompileRouteOptions<Context>,
) {
  const { buildSnapshot, compileSources, sourcesCurrent } =
    createCompileSources(options.project);
  type CompileArgs = CompileHandlerArgs<Context>;
  return {
    POST: async ({ request, params, context }: CompileArgs) => {
      const started = performance.now();
      const receivedAt = new Date().toISOString();
      const { db } = context;
      if (new URL(request.url).searchParams.get("changed") === "1") {
        const denied = await checkProject(
          request,
          params.projectId,
          context,
          options,
        );
        if (denied instanceof Response) return denied;
        const body = await readPreviewBody(request);
        if (!body) return json({ error: "Invalid editor revision" }, 400);
        return fetchBuilds(`/projects/${params.projectId}/changed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      const denied = await resolveAuthorizedPrincipal(
        request,
        params.projectId,
        context,
        options,
      );
      if (denied instanceof Response) return denied;
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
      const clientVersion = request.headers.get("X-Source-Metadata") ?? "";
      let prep:
        | { reserved: false; conflict: boolean }
        | {
            reserved: true;
            version: string;
            nodes: Awaited<
              ReturnType<Db["query"]["projectNode"]["findMany"]>
            > | null;
          };
      try {
        prep = await db.transaction(async (tx) => {
          await options.project.lock({
            tx,
            projectId: params.projectId,
            userId: denied.userId,
            access: "write",
          });
          const [reserved] = await tx
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
            const existing = await tx.query.projectJob.findFirst({
              columns: { id: true },
              where: { id, projectId: params.projectId, requestDigest },
            });
            return { reserved: false as const, conflict: !existing };
          }
          const version = await options.project.metadataVersion({
            tx,
            projectId: params.projectId,
            userId: denied.userId,
          });
          const nodes =
            version === clientVersion
              ? null
              : await tx.query.projectNode.findMany({
                  where: {
                    projectId: params.projectId,
                    deletedAt: { isNull: true },
                  },
                });
          return { reserved: true as const, version, nodes };
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Project not found")
          return json({ error: "Project not found" }, 404);
        throw error;
      }
      if (!prep.reserved) {
        if (prep.conflict)
          return json({ error: "Compilation ID already used" }, 409);
        // The reserving request owns submission, even while its response is
        // uncertain. Reconcile through GET without resubmitting newer sources.
        return submissionResponse({ id, projectId: params.projectId });
      }
      const plan = await options.compilePlan(db, denied.userId);

      let submitted = false;
      let revision: number | undefined;
      let sourceRevision: number | undefined;
      try {
        const send = (sources: object) => {
          submitted = true;
          return fetchBuilds(`/projects/${params.projectId}/compile`, {
            method: "POST",
            // Source synchronization can outlast the default 15-second timeout.
            signal: request.signal,
            headers: {
              "Content-Type": "application/json",
              "X-Compilation-Id": id,
              "X-Request-Digest": requestDigest,
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
        const project = {
          db,
          projectId: params.projectId,
          userId: denied.userId,
        };
        let { sources, version } = await buildSnapshot({
          projectId: params.projectId,
          mainFile: body.mainFile,
          sourceRevision: body.baseRevision,
          version: prep.version,
          nodes: prep.nodes,
          client: {
            version: clientVersion,
            delta: body,
          },
        });
        let response = await send(sources);
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
            ({ sources, version } = await compileSources({
              ...project,
              mainFile: body.mainFile,
              sourceRevision: resync.data.sourceRevision,
            }));
            response = await send(sources);
          }
        }
        if (response.status === 202) {
          const accepted = acceptedJobSchema.parse(await response.json());
          if (accepted.id !== id) throw new Error("Invalid compiler job ID");
          revision = accepted.revision;
          sourceRevision = accepted.sourceRevision;
          // The project was not locked during submission. A change since the
          // snapshot may have invalidated the build before this one existed.
          if (
            !(await sourcesCurrent({ ...project, version }).catch(() => false))
          )
            await invalidateSourceBuild(params.projectId);
        } else if (response.status < 500) {
          const parsed = failure.safeParse(
            await response.json().catch(() => null),
          );
          const detail = parsed.success
            ? parsed.data
            : { error: "Compilation service failed" };
          await updateProjectJob(db, id, {
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
          await updateProjectJob(db, id, {
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
      const denied = await checkProject(
        request,
        params.projectId,
        context,
        options,
      );
      if (denied instanceof Response) return denied;
      const id = idSchema.safeParse(
        new URL(request.url).searchParams.get("job"),
      );
      if (!id.success) return json({ error: "Job not found" }, 404);
      const job = await context.db.query.projectJob.findFirst({
        columns: { id: true, status: true, timing: true },
        where: { id: id.data, projectId: params.projectId },
      });
      if (!job || !["succeeded", "failed"].includes(job.status))
        return json({ error: "Job not found" }, 404);
      const body = await readPreviewTiming(request);
      if (!body) return json({ error: "Invalid preview timing" }, 400);
      // Persist the first report for the Logs timeline. Pruned or older jobs
      // have no timeline to extend.
      await context.db
        .update(projectJob)
        .set({ timing: mergeJobTiming({ client: body }) })
        .where(
          and(
            eq(projectJob.id, id.data),
            eq(projectJob.projectId, params.projectId),
            isNotNull(projectJob.timing),
            sql`${projectJob.timing} -> 'client' is null`,
          ),
        );
      console.info({
        ...parseJobTimeline(job.timing).compiler,
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
      const denied = await checkProject(
        request,
        params.projectId,
        context,
        options,
      );
      if (denied instanceof Response) return denied;
      const url = new URL(request.url);
      if (url.searchParams.get("history") === "1") {
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
          if (file !== null)
            return await fetchBuilds(
              `/projects/${params.projectId}/build/files?path=${encodeURIComponent(file)}&version=${encodeURIComponent(url.searchParams.get("version") ?? "")}`,
            );
          if (url.searchParams.get("events") !== "1")
            return await fetchBuilds(`/projects/${params.projectId}`);
          if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
            return new Response("WebSocket required", { status: 426 });
          if (url.origin !== request.headers.get("Origin"))
            return new Response("Invalid origin", { status: 403 });
          return await connectBuilds(params.projectId, denied.userId);
        } catch {
          return json({ error: "Project coordinator unavailable" }, 502);
        }
      }
      const parsedId = idSchema.safeParse(url.searchParams.get("job"));
      if (!parsedId.success) return json({ error: "Job not found" }, 404);
      const id = parsedId.data;
      const job = await db.query.projectJob.findFirst({
        columns: {
          id: true,
          status: true,
          createdAt: true,
          log: true,
          error: true,
          sizeBytes: true,
        },
        where: { id, projectId: params.projectId },
      });
      if (!job) return json({ error: "Job not found" }, 404);
      if (url.searchParams.get("log") === "1")
        return json({ id, status: job.status, log: job.log ?? "" });
      const pdfPath = `/projects/${params.projectId}/compilations/${id}.pdf`;
      try {
        if (url.searchParams.get("preview") === "pdf") {
          const response = await fetchBuilds(
            `/projects/${params.projectId}/jobs/${id}/pdf`,
            {
              // The stream ends when this user loses access to the project.
              headers: { [liveUserHeader]: denied.userId },
              signal: AbortSignal.any([
                request.signal,
                AbortSignal.timeout(10 * 60_000),
              ]),
            },
          );
          if (!response.ok) return response;
          if (response.headers.get("Content-Type") !== "application/pdf")
            throw new Error("Invalid compiler PDF stream");
          return new Response(response.body, {
            headers: {
              ...noStore,
              "Content-Type": "application/pdf",
              "X-Accel-Buffering": "no",
            },
          });
        }
        if (url.searchParams.get("artifact") === "pdf") {
          if (job.status !== "succeeded")
            return json({ error: "PDF not found" }, 404);
          const pdf = await fetchBuilds(pdfPath);
          if (pdf.status === 404) return json({ error: "PDF not found" }, 404);
          if (!pdf.ok || pdf.headers.get("Content-Type") !== "application/pdf")
            throw new Error("Invalid compiler PDF response");
          return new Response(pdf.body, {
            headers: {
              "Cache-Control": immutableArtifact,
              "Content-Type": "application/pdf",
            },
          });
        }
        if (job.status === "succeeded") {
          return json({
            id,
            status: "succeeded",
            log: job.log ?? "",
            sizeBytes: Number(job.sizeBytes),
            artifactUrl: `/api/compile/${params.projectId}?job=${id}&artifact=pdf`,
          });
        }
        if (job.status === "failed") {
          return json({
            id,
            status: "failed",
            error: job.error ?? "Compilation failed",
            log: job.log ?? "",
          });
        }

        const response = await fetchBuilds(
          `/projects/${params.projectId}/jobs/${id}`,
        );
        if (response.status === 404) {
          if (Date.now() - job.createdAt.getTime() < 30_000)
            return json({ id, status: "queued" }, 200, {
              ...noStore,
              "Retry-After": "1",
            });
          const error = "The compiler did not receive this job. Try again.";
          await updateProjectJob(db, id, {
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
            await reconcileProjectJob(db, params.projectId, result);
            return json({
              ...result,
              artifactUrl: `/api/compile/${params.projectId}?job=${id}&artifact=pdf`,
            });
          case "failed":
            await reconcileProjectJob(db, params.projectId, result);
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
}
