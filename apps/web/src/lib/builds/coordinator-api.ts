import { jobIdSchema, planSchema } from "@texfolia/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { immutableArtifact } from "./client";
import {
  editorVersionSchema,
  type ProjectCoordinatorCore,
} from "./coordinator";
import { compileUserSchema } from "./limits";
import { HttpError } from "./project";
import {
  maxSourceSyncBytes,
  sourceDeltaSchema,
  sourceHash,
  SourceResyncError,
  sourceSnapshotSchema,
} from "./source-sync";

function parseSnapshot(body: unknown) {
  const parsed = sourceSnapshotSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "Invalid project sources");
  return parsed.data;
}

export function createCoordinatorApp(
  coordinator: ProjectCoordinatorCore,
  admit?: (request: Request) => Promise<Response | null>,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/projects/:projectId", (c) => c.json(coordinator.snapshot()));
  app.post("/projects/:projectId/changed", async (c) => {
    const body: unknown = await c.req.json();
    // The app's own changes come from no editor.
    const version = z
      .union([
        editorVersionSchema,
        z.strictObject({}).transform(() => undefined),
      ])
      .safeParse(body);
    if (!version.success)
      return c.json({ error: "Invalid editor revision" }, 400);
    await coordinator.changed(version.data);
    return c.json(coordinator.snapshot());
  });
  app.delete("/projects/:projectId/build", async (c) => {
    await coordinator.clear();
    return c.body(null, 204);
  });
  app.get("/projects/:projectId/build/files", async (c) => {
    const path = c.req.query("path");
    const version = c.req.query("version");
    const file = path ? await coordinator.file(path, version) : null;
    return file
      ? new Response(file, {
          headers: {
            "Content-Type": path?.endsWith(".pdf")
              ? "application/pdf"
              : "application/octet-stream",
            "Cache-Control": version ? immutableArtifact : "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        })
      : c.json({ error: "Build file not found" }, 404);
  });
  app.post(
    "/projects/:projectId/compile",
    async (c, next) => {
      const denied = await admit?.(c.req.raw);
      if (denied) return denied;
      await next();
    },
    bodyLimit({
      maxSize: maxSourceSyncBytes,
      onError: (c) => c.json({ error: "Source sync exceeds 12 MiB" }, 413),
    }),
    async (c) => {
      if (!c.req.header("Content-Type")?.startsWith("application/json"))
        return c.json({ error: "Expected application/json" }, 415);
      const id = jobIdSchema.safeParse(
        c.req.header("X-Compilation-Id") ?? crypto.randomUUID(),
      );
      if (!id.success) return c.json({ error: "Invalid compilation ID" }, 400);
      const headerDigest = c.req.header("X-Request-Digest");
      let digest: string;
      let body: unknown;
      if (headerDigest && /^[0-9a-f]{64}$/.test(headerDigest)) {
        digest = headerDigest;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: "Invalid JSON" }, 400);
        }
      } else {
        // Hash the bytes as sent when the caller did not supply a request digest.
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        digest = await sourceHash(bytes);
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return c.json({ error: "Invalid JSON" }, 400);
        }
      }
      const editorId = c.req.header("X-Editor-Id");
      const sequence = c.req.header("X-Editor-Sequence");
      const version =
        editorId || sequence
          ? editorVersionSchema.safeParse({
              editorId,
              sequence: sequence === undefined ? NaN : Number(sequence),
            })
          : null;
      if (version && !version.success)
        return c.json({ error: "Invalid editor revision" }, 400);
      const job = await coordinator.submit(
        id.data,
        typeof body === "object" && body !== null && "baseRevision" in body
          ? sourceDeltaSchema.parse(body)
          : parseSnapshot(body),
        digest,
        planSchema.catch("unknown").parse(c.req.header("X-Compile-Plan")),
        version?.data,
        {
          userId: compileUserSchema
            .optional()
            .parse(c.req.header("X-Compile-User")),
          clean: c.req.header("X-Clean-Build") === "1",
          builtBy: decodeURIComponent(
            c.req.header("X-Build-User") ?? "Unknown",
          ),
        },
      );
      return c.json(
        {
          ...job,
          statusUrl: `/projects/${c.req.param("projectId")}/jobs/${job.id}`,
        },
        202,
      );
    },
  );
  app.get("/projects/:projectId/jobs/:id", async (c) => {
    const id = jobIdSchema.safeParse(c.req.param("id"));
    const job = id.success ? await coordinator.get(id.data) : null;
    return job ? c.json(job) : c.json({ error: "Job not found" }, 404);
  });
  app.get("/projects/:projectId/jobs/:id/pdf", async (c) => {
    const id = jobIdSchema.safeParse(c.req.param("id"));
    return id.success
      ? coordinator.preview(id.data, c.req.raw.signal)
      : c.json({ error: "Job not found" }, 404);
  });
  app.get("/projects/:projectId/compilations/:file", async (c) => {
    const file = c.req.param("file");
    const png = file.endsWith(".png");
    const id = jobIdSchema.safeParse(file.replace(/\.(pdf|png)$/, ""));
    const body = !id.success
      ? null
      : png
        ? await coordinator.previewImage(id.data)
        : await coordinator.artifact(id.data);
    return body
      ? new Response(body, {
          headers: {
            "Content-Type": png ? "image/png" : "application/pdf",
            "Cache-Control": "no-store",
          },
        })
      : c.json({ error: `${png ? "PNG" : "PDF"} not found` }, 404);
  });
  app.onError((error, c) => {
    if (error instanceof SourceResyncError)
      return c.json(
        { error: error.message, resync: true, sourceRevision: error.revision },
        409,
      );
    if (error instanceof z.ZodError)
      return c.json({ error: "Invalid source delta" }, 400);
    if (error instanceof HttpError)
      return new Response(
        JSON.stringify({ error: error.message, log: error.log }),
        {
          status: error.status,
          headers: {
            "Content-Type": "application/json",
            ...(error.retryAfter
              ? { "Retry-After": String(error.retryAfter) }
              : {}),
          },
        },
      );
    console.error("Project coordinator failed", { error });
    return c.json({ error: "Compilation service failed" }, 503);
  });
  return app;
}
