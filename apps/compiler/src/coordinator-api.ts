import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import {
  editorVersionSchema,
  type ProjectCoordinatorCore,
} from "./coordinator";
import { compileUserSchema } from "./limits";
import { HttpError, jobIdSchema, parseProject } from "./project";
import {
  maxSourceSyncBytes,
  sourceDeltaSchema,
  SourceResyncError,
} from "./source-sync";
import { planSchema } from "./telemetry";

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
  app.get("/projects/:projectId/events", (c) =>
    coordinator.events(c.req.raw.signal),
  );
  app.post("/projects/:projectId/changed", async (c) => {
    const body: unknown = await c.req.json();
    const version = editorVersionSchema.safeParse(body);
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
    const file = path
      ? await coordinator.file(path, c.req.query("version"))
      : null;
    return file
      ? new Response(file, {
          headers: {
            "Content-Type": path?.endsWith(".pdf")
              ? "application/pdf"
              : "application/octet-stream",
            "Cache-Control": "no-store",
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
      onError: (c) => c.json({ error: "Source sync exceeds 64 MiB" }, 413),
    }),
    async (c) => {
      if (!c.req.header("Content-Type")?.startsWith("application/json"))
        return c.json({ error: "Expected application/json" }, 415);
      const id = jobIdSchema.safeParse(
        c.req.header("X-Compilation-Id") ?? crypto.randomUUID(),
      );
      if (!id.success) return c.json({ error: "Invalid compilation ID" }, 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
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
          : parseProject(body),
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
    const id = jobIdSchema.safeParse(c.req.param("file").replace(/\.pdf$/, ""));
    const pdf = id.success ? await coordinator.artifact(id.data) : null;
    return pdf
      ? new Response(pdf, {
          headers: {
            "Content-Type": "application/pdf",
            "Cache-Control": "no-store",
          },
        })
      : c.json({ error: "PDF not found" }, 404);
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
