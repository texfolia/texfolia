import { Effect, Layer, Schedule, Schema } from "effect";

import { Containers } from "./containers";
import { ContainerError } from "./errors";

export type DockerOptions = {
  socket: string;
  image: string;
  network?: string;
  concurrency: number;
};

const Inspection = Schema.Struct({
  State: Schema.Struct({ Running: Schema.Boolean }),
  NetworkSettings: Schema.Struct({
    Ports: Schema.Record(
      Schema.String,
      Schema.NullOr(Schema.Array(Schema.Struct({ HostPort: Schema.String }))),
    ),
  }),
});
const decodeInspection = Schema.decodeUnknownSync(Inspection);

/** Compile containers on the local Docker daemon. */
export const dockerContainers = (options: DockerOptions) => {
  const endpoints = new Map<string, string>();
  const docker = (path: string, init?: RequestInit) =>
    fetch(`http://docker/v1.45${path}`, {
      ...init,
      unix: options.socket,
      signal: AbortSignal.timeout(30_000),
    });
  const attempt = <A>(
    operation: string,
    container: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new ContainerError({ operation, container, cause }),
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
    let info = decodeInspection(await response.json());
    if (!info.State.Running) {
      const started = await docker(`/containers/${id}/start`, {
        method: "POST",
      });
      if (!started.ok)
        throw new Error(`Cannot start compile container (${started.status})`);
      info = decodeInspection(
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

  const health = (operation: string, name: string) =>
    attempt(operation, name, async (signal) => {
      const url = endpoints.get(name) ?? (await run(name));
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(`Container health returned ${response.status}`);
    });

  return Containers.of({
    start: (name) =>
      attempt("start", name, () => run(name)).pipe(
        Effect.andThen(
          health("start", name).pipe(
            Effect.retry({
              times: 300,
              schedule: Schedule.spaced("100 millis"),
            }),
          ),
        ),
      ),
    probe: (name) => health("probe", name),
    stop: (name) =>
      attempt("stop", name, async () => {
        const response = await docker(
          `/containers/${dockerName(name)}?force=true`,
          { method: "DELETE" },
        );
        if (!response.ok && response.status !== 404)
          throw new Error(
            `Cannot remove compile container (${response.status})`,
          );
        endpoints.delete(name);
      }),
    fetch: (name, request) =>
      attempt("fetch", name, async (signal) => {
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
      }),
  });
};

export const dockerLayer = (options: DockerOptions) =>
  Layer.sync(Containers, () => dockerContainers(options));
