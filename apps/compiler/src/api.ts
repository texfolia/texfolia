import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";

import type { Jobs } from "./jobs";
import { compileUserSchema } from "./limits";
import {
  HttpError,
  jobIdSchema,
  maxProjectBytes,
  parseProject,
} from "./project";
import { emitCompileEvent, planSchema } from "./telemetry";

export interface ApiBindings {
  jobs: Jobs;
  admit: (request: Request) => Promise<Response | null>;
}

export function createApp() {
  const app = new Hono<{ Bindings: ApiBindings }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/health", (c) => c.json({ status: "ready" }));
  app.post(
    "/compile",
    async (c, next) => {
      const denied = await c.env.admit(c.req.raw);
      if (denied) return denied;
      await next();
    },
    bodyLimit({
      maxSize: maxProjectBytes,
      onError: (c) => c.json({ error: "Project exceeds 10 MiB" }, 413),
    }),
    async (c) => {
      if (!c.req.header("Content-Type")?.startsWith("application/json"))
        return c.json({ error: "Expected application/json" }, 415);
      const parsedId = jobIdSchema.safeParse(
        c.req.header("X-Compilation-Id") ?? crypto.randomUUID(),
      );
      if (!parsedId.success)
        return c.json({ error: "Invalid compilation ID" }, 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }
      const started = performance.now();
      const job = await c.env.jobs.submit(
        parsedId.data,
        parseProject(body),
        planSchema.catch("unknown").parse(c.req.header("X-Compile-Plan")),
        compileUserSchema.optional().parse(c.req.header("X-Compile-User")),
      );
      emitCompileEvent({
        event: "compile_submission",
        jobId: job.id,
        plan: job.plan,
        submissionMs: performance.now() - started,
      });
      const statusUrl = `/jobs/${job.id}`;
      c.header("Location", statusUrl);
      c.header("Retry-After", "1");
      const { digest: _, ...status } = job;
      return c.json({ ...status, statusUrl }, 202);
    },
  );
  app.get("/jobs/:id", async (c) => {
    const id = jobIdSchema.safeParse(c.req.param("id"));
    const job = id.success ? await c.env.jobs.get(id.data) : null;
    if (!job) return c.json({ error: "Job not found" }, 404);
    if (job.status === "queued" || job.status === "running")
      c.header("Retry-After", "1");
    const { digest: _, ...status } = job;
    return c.json(status);
  });
  app.get("/compilations/:file", async (c) => {
    const file = c.req.param("file");
    const extension = file.endsWith(".png") ? "png" : "pdf";
    const id = jobIdSchema.safeParse(
      file.endsWith(`.${extension}`) ? file.slice(0, -4) : "",
    );
    const pdf = id.success
      ? await c.env.jobs.artifact(id.data, extension)
      : null;
    return pdf
      ? new Response(pdf, {
          headers: {
            "Content-Type":
              extension === "png" ? "image/png" : "application/pdf",
            "Cache-Control": "no-store",
          },
        })
      : c.json({ error: `${extension.toUpperCase()} not found` }, 404);
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof HttpError)
      return new Response(
        JSON.stringify({ error: error.message, log: error.log }),
        {
          status: error.status,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...(error.retryAfter
              ? { "Retry-After": String(error.retryAfter) }
              : {}),
          },
        },
      );
    console.error("Compiler API failed", { error });
    return c.json({ error: "Compilation service failed" }, 503);
  });
  return app;
}
