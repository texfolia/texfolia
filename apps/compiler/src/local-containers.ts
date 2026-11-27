import { z } from "zod";

import type { ContainerPlatform } from "./containers";

export type DockerOptions = {
  socket: string;
  image: string;
  network?: string;
  concurrency: number;
};

const inspectionSchema = z.object({
  State: z.object({ Running: z.boolean() }),
  NetworkSettings: z.object({
    Ports: z.record(
      z.string(),
      z.array(z.object({ HostPort: z.string() })).nullable(),
    ),
  }),
});

/** Compile containers on the local Docker daemon. */
export function dockerContainers(options: DockerOptions): ContainerPlatform {
  const endpoints = new Map<string, string>();
  const docker = (path: string, init?: RequestInit) =>
    fetch(`http://docker/v1.45${path}`, {
      ...init,
      unix: options.socket,
      signal: AbortSignal.timeout(30_000),
    });
  const dockerName = (name: string) => `texfolia-${name}`;

  const run = async (name: string) => {
    const id = dockerName(name);
    let response = await docker(`/containers/${id}/json`);
    if (response.status === 404) {
      const created = await docker(`/containers/create?name=${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Image: options.image,
          Labels: { "texfolia.compiler": "true" },
          Env: [`COMPILE_SLOTS=${options.concurrency}`],
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
          `Cannot create compile container (${created.status}); build ${options.image} first`,
        );
      response = await docker(`/containers/${id}/json`);
    }
    if (!response.ok)
      throw new Error(`Cannot inspect compile container (${response.status})`);
    let info = inspectionSchema.parse(await response.json());
    if (!info.State.Running) {
      const started = await docker(`/containers/${id}/start`, {
        method: "POST",
      });
      if (!started.ok)
        throw new Error(`Cannot start compile container (${started.status})`);
      info = inspectionSchema.parse(
        await (await docker(`/containers/${id}/json`)).json(),
      );
    }
    const port = info.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;
    const url = options.network
      ? `http://${id}:8080`
      : `http://127.0.0.1:${port}`;
    endpoints.set(name, url);
    return url;
  };

  const healthOnce = async (name: string, signal?: AbortSignal) => {
    const url = endpoints.get(name) ?? (await run(name));
    const response = await fetch(`${url}/health`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(1000)])
        : AbortSignal.timeout(1000),
    });
    await response.body?.cancel();
    if (!response.ok)
      throw new Error(`Container health returned ${response.status}`);
  };

  return {
    async start(name, signal) {
      await run(name);
      let lastError: unknown;
      for (let attempt = 0; attempt <= 300; attempt++) {
        signal?.throwIfAborted();
        try {
          await healthOnce(name, signal);
          return;
        } catch (error) {
          lastError = error;
          await Bun.sleep(100);
        }
      }
      throw lastError ?? new Error("Container failed readiness check");
    },
    async stop(name) {
      const response = await docker(
        `/containers/${dockerName(name)}?force=true`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 404)
        throw new Error(`Cannot remove compile container (${response.status})`);
      endpoints.delete(name);
    },
    async fetch(name, request, signal) {
      const url = endpoints.get(name) ?? (await run(name));
      try {
        return await fetch(
          new Request(
            new URL(new URL(request.url).pathname, url).href,
            request,
          ),
          { signal },
        );
      } catch (error) {
        endpoints.delete(name);
        throw error;
      }
    },
  };
}
