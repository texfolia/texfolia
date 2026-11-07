import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { compile } from "./compile";
import { HttpError, maxProjectBytes, parseProject } from "./project";

export function createEngineHandler(
  options: { compile?: typeof compile } = {},
) {
  const app = new Hono();
  let busy = false;
  app.get("/health", (c) => c.json({ status: "ready" }));
  app.post(
    "/compile",
    bodyLimit({
      maxSize: maxProjectBytes,
      onError: (c) => c.json({ error: "Project exceeds 10 MiB" }, 413),
    }),
    async (c) => {
      if (busy) {
        c.header("Retry-After", "1");
        return c.json({ error: "Compiler busy; retry shortly" }, 503);
      }
      busy = true;
      try {
        if (!c.req.header("Content-Type")?.startsWith("application/json"))
          return c.json({ error: "Expected application/json" }, 415);
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: "Invalid JSON" }, 400);
        }
        const result = await (options.compile ?? compile)(parseProject(body));
        const form = new FormData();
        form.set(
          "pdf",
          new Blob([new Uint8Array(result.pdf)], { type: "application/pdf" }),
          "output.pdf",
        );
        form.set("log", result.log);
        return new Response(form, { headers: { "Cache-Control": "no-store" } });
      } finally {
        busy = false;
      }
    },
  );
  app.onError((error, c) => {
    if (error instanceof HttpError)
      return Response.json(
        { error: error.message, log: error.log },
        { status: error.status },
      );
    console.error("TeX host failed", { error });
    return c.json({ error: "Compilation service failed" }, 500);
  });
  return (request: Request) => app.fetch(request);
}
