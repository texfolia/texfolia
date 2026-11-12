import { z } from "zod";

import { createEngineClient } from "./engine";
import type { Engine } from "./jobs";
import { jobIdSchema } from "./project";

const inspection = z.object({
  State: z.object({ Running: z.boolean() }),
  NetworkSettings: z.object({
    Ports: z.record(
      z.string(),
      z.array(z.object({ HostPort: z.string() })).nullable(),
    ),
  }),
});

// The coordinator is the sole owner of this name for the container's whole life.
// A restarted API reattaches to the same project, never to an unassigned pool.
export function localProjectEngine(
  projectId: string,
  options: {
    socket: string;
    image: string;
    network?: string;
  },
): Engine {
  jobIdSchema.parse(projectId);
  const name = `texfolia-project-${projectId}`;
  async function docker(path: string, init?: RequestInit) {
    const response = await fetch(`http://docker/v1.45${path}`, {
      ...init,
      unix: options.socket,
      signal: AbortSignal.timeout(30_000),
    });
    return response;
  }
  let endpoint: Promise<string> | undefined;
  async function start() {
    let response = await docker(`/containers/${name}/json`);
    if (response.status === 404) {
      const created = await docker(`/containers/create?name=${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Image: options.image,
          Labels: { "texfolia.project": projectId },
          ExposedPorts: { "8080/tcp": {} },
          HostConfig: {
            Memory: 1024 * 1024 * 1024,
            NanoCpus: 1_000_000_000,
            PidsLimit: 64,
            SecurityOpt: ["no-new-privileges:true"],
            ...(options.network
              ? { NetworkMode: options.network }
              : {
                  PortBindings: {
                    "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
                  },
                }),
          },
        }),
      });
      if (!created.ok && created.status !== 409)
        throw new Error(
          `Cannot create project engine (${created.status}); build ${options.image} first`,
        );
      response = await docker(`/containers/${name}/json`);
    }
    if (!response.ok)
      throw new Error(`Cannot inspect project engine (${response.status})`);
    let info = inspection.parse(await response.json());
    if (!info.State.Running) {
      const started = await docker(`/containers/${name}/start`, {
        method: "POST",
      });
      if (!started.ok)
        throw new Error(`Cannot start project engine (${started.status})`);
      info = inspection.parse(
        await (await docker(`/containers/${name}/json`)).json(),
      );
    }
    const port = info.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;
    const url = options.network
      ? `http://${name}:8080`
      : `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(1000),
      }).catch(() => null);
      if (ready?.ok) return url;
      await Bun.sleep(100);
    }
    throw new Error("Project engine did not become ready");
  }
  return createEngineClient(async (request) => {
    endpoint ??= start().catch((error) => {
      endpoint = undefined;
      throw error;
    });
    const url = await endpoint;
    try {
      return await fetch(
        new Request(new URL(new URL(request.url).pathname, url).href, request),
      );
    } catch (error) {
      endpoint = undefined;
      throw error;
    }
  });
}
