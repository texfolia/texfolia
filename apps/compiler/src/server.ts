import { compile, HttpError, parseProject } from "./compile";

export function createHandler(options: { token?: string; compile?: typeof compile } = {}) {
  let busy = false;
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return Response.json({ status: "ready" });
    if (options.token && request.headers.get("authorization") !== `Bearer ${options.token}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (path !== "/compile") return Response.json({ error: "Not found" }, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    if (busy) return Response.json({ error: "Compiler busy; retry shortly" }, { status: 503, headers: { "Retry-After": "1" } });
    busy = true;
    try {
      if (!request.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415, "Expected application/json");
      // Enforce the limit for chunked requests too, before JSON parsing.
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new HttpError(413, "Project exceeds 10 MiB"); }
          chunks.push(value);
        }
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new HttpError(400, "Invalid JSON"); }
      const result = await (options.compile ?? compile)(parseProject(body));
      return new Response(result.pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="output.pdf"', "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message, log: error.log }, { status: error.status });
      console.error(error);
      return Response.json({ error: "Compilation service failed" }, { status: 500 });
    } finally { busy = false; }
  };
}
