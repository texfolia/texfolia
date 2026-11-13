import { WorkerEntrypoint } from "cloudflare:workers";

import type { ProjectCollaboration } from "../../src/lib/collaboration/project-collaboration";
export { ProjectCollaboration } from "../../src/lib/collaboration/project-collaboration";

// This entry point exists only in the isolated integration runtime. Production
// identity comes from the authenticated route, never from this test cookie.
export default {
  async fetch(
    request: Request,
    env: {
      COLLABORATION: DurableObjectNamespace<ProjectCollaboration>;
      CLIENT: Fetcher;
    },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/client.js") return env.CLIENT.fetch(request);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response(
        '<!doctype html><html><head><title>Collaboration integration</title></head><body><script type="module" src="/client.js"></script></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    const [, , , projectId, nodeId] = url.pathname.split("/");
    const userId =
      /test-user=([^;]+)/.exec(request.headers.get("Cookie") ?? "")?.[1] ?? "";
    const headers = new Headers({
      Upgrade: "websocket",
      "X-Collaboration-Session": JSON.stringify({
        projectId,
        nodeId,
        userId,
        name: userId,
        clientId: Number(url.searchParams.get("clientId")),
        awareness: null,
      }),
    });
    try {
      return await env.COLLABORATION.getByName(projectId ?? "").fetch(
        new Request(request.url, { headers }),
      );
    } catch (error) {
      console.error(error);
      return new Response(String(error), { status: 500 });
    }
  },
};

export class CompilerFixture extends WorkerEntrypoint {
  override fetch() {
    return new Response(null, { status: 204 });
  }
}
