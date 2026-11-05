import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  COMPILER: DurableObjectNamespace<TectonicContainer>;
  PDFS: R2Bucket;
  COMPILER_TOKEN: string;
}

export class TectonicContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
  override envVars = {
    NODE_ENV: "production",
    COMPILER_TOKEN: this.env.COMPILER_TOKEN,
  };

  // Keep this singleton warm even when there are no compilation requests.
  override async onActivityExpired() {
    /* Intentionally keep the container running. */
  }
}

export default {
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      getContainer(env.COMPILER, "compiler").fetch("http://container/health"),
    );
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (
      !env.COMPILER_TOKEN ||
      request.headers.get("authorization") !== `Bearer ${env.COMPILER_TOKEN}`
    ) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const path = new URL(request.url).pathname;
    if (
      request.method === "GET" &&
      /^\/compilations\/[0-9a-f-]{36}\.pdf$/.test(path)
    ) {
      const object = await env.PDFS.get(path.slice(1));
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/pdf",
          "Cache-Control": "no-store",
        },
      });
    }
    if (path !== "/compile" && path !== "/health")
      return new Response("Not found", { status: 404 });
    const requestedId = request.headers.get("X-Compilation-Id");
    if (
      requestedId &&
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestedId)
    ) {
      return Response.json(
        { error: "Invalid compilation ID" },
        { status: 400 },
      );
    }
    const response = await getContainer(env.COMPILER, "compiler").fetch(
      request,
    );
    if (path !== "/compile" || !response.ok || !requestedId) return response;
    const id = requestedId;
    const multipart = response.headers
      .get("Content-Type")
      ?.startsWith("multipart/form-data");
    const pdf = multipart
      ? (await response.clone().formData()).get("pdf")
      : await response.clone().arrayBuffer();
    if (!(pdf instanceof Blob || pdf instanceof ArrayBuffer)) {
      return Response.json(
        { error: "Compiler returned no PDF" },
        { status: 502 },
      );
    }
    const object = await env.PDFS.put(`compilations/${id}.pdf`, pdf, {
      httpMetadata: { contentType: "application/pdf" },
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (!object)
      return Response.json(
        { error: "Compilation already stored" },
        { status: 409 },
      );
    const headers = new Headers(response.headers);
    headers.set("X-Compilation-Id", id);
    headers.set("Location", `/compilations/${id}.pdf`);
    headers.set("X-Compilation-Size", String(object.size));
    return new Response(response.body, { headers });
  },
} satisfies ExportedHandler<Env>;
