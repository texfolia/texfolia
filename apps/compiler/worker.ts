import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  COMPILER: DurableObjectNamespace<TectonicContainer>;
  PDFS: R2Bucket;
  COMPILER_TOKEN: string;
}

export class TectonicContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
  override envVars = { NODE_ENV: "production", COMPILER_TOKEN: this.env.COMPILER_TOKEN };

  // Keep this singleton warm even when there are no compilation requests.
  override async onActivityExpired() { /* Intentionally keep the container running. */ }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(getContainer(env.COMPILER, "compiler").fetch("http://container/health"));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.COMPILER_TOKEN || request.headers.get("authorization") !== `Bearer ${env.COMPILER_TOKEN}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && /^\/compilations\/[0-9a-f-]{36}\.pdf$/.test(path)) {
      const object = await env.PDFS.get(path.slice(1));
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } });
    }
    if (path !== "/compile" && path !== "/health") return new Response("Not found", { status: 404 });
    const response = await getContainer(env.COMPILER, "compiler").fetch(request);
    if (path !== "/compile" || !response.ok) return response;
    const id = crypto.randomUUID();
    const pdf = await response.arrayBuffer();
    await env.PDFS.put(`compilations/${id}.pdf`, pdf, { httpMetadata: { contentType: "application/pdf" } });
    const headers = new Headers(response.headers);
    headers.set("X-Compilation-Id", id);
    headers.set("Location", `/compilations/${id}.pdf`);
    return new Response(pdf, { headers });
  },
} satisfies ExportedHandler<Env>;
