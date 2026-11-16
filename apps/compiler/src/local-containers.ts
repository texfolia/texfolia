import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import type { Engine, ObjectStore } from "./jobs";
import { PoolCore, poolClaimSchema, type PoolClaim } from "./pool";
import { createPooledEngine } from "./pooled-engine";
import { jobIdSchema } from "./project";
import { createProjectEngineClient } from "./project-engine";

const inspection = z.object({
  State: z.object({ Running: z.boolean() }),
  NetworkSettings: z.object({
    Ports: z.record(
      z.string(),
      z.array(z.object({ HostPort: z.string() })).nullable(),
    ),
  }),
});

type DockerOptions = {
  socket: string;
  image: string;
  network?: string;
};

function containerTransport(name: string, options: DockerOptions) {
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
          Labels: { "texfolia.compiler": "true" },
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
  return {
    fetch: async (request: Request) => {
      endpoint ??= start().catch((error) => {
        endpoint = undefined;
        throw error;
      });
      const url = await endpoint;
      try {
        return await fetch(
          new Request(
            new URL(new URL(request.url).pathname, url).href,
            request,
          ),
        );
      } catch (error) {
        endpoint = undefined;
        throw error;
      }
    },
    async destroy() {
      const response = await docker(`/containers/${name}?force=true`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404)
        throw new Error(`Cannot remove pooled engine (${response.status})`);
      endpoint = undefined;
    },
  };
}

export function createLocalContainerPool(
  options: DockerOptions & { path: string },
) {
  mkdirSync(dirname(options.path), { recursive: true });
  const db = new Database(options.path, { strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  let pending: { key: string; claim: PoolClaim } | undefined;
  const transports = new Map<string, ReturnType<typeof containerTransport>>();
  const transport = (name: string) => {
    let result = transports.get(name);
    if (!result) {
      result = containerTransport(
        `texfolia-${name.replaceAll(":", "-")}`,
        options,
      );
      transports.set(name, result);
    }
    return result;
  };
  const pool = new PoolCore({
    saved:
      db
        .query<{ value: string }, []>("SELECT value FROM state WHERE id = 1")
        .get()?.value ?? null,
    save: (value) =>
      db.transaction(() => {
        if (pending) {
          db.run("INSERT INTO claims VALUES (?, ?)", [
            pending.key,
            JSON.stringify(pending.claim),
          ]);
          pending = undefined;
        }
        db.run("INSERT OR REPLACE INTO state VALUES (1, ?)", [value]);
      })(),
    lookup: (key) => {
      const row = db
        .query<{ value: string }, [string]>(
          "SELECT value FROM claims WHERE key = ?",
        )
        .get(key);
      return row ? poolClaimSchema.parse(JSON.parse(row.value)) : undefined;
    },
    assign: (key, claim) => {
      pending = { key, claim };
    },
    start: async (name) => {
      const response = await transport(name).fetch(
        new Request("http://container/health"),
      );
      await response.body?.cancel();
      if (!response.ok) throw new Error("Pooled engine health check failed");
    },
    stop: async (name) => {
      await transport(name).destroy();
      transports.delete(name);
    },
    reset: async (name, token) => {
      const response = await transport(name).fetch(
        new Request("http://container/lease", {
          method: "DELETE",
          headers: { "X-Container-Lease": token },
          signal: AbortSignal.timeout(90_000),
        }),
      );
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(`Pooled engine reset failed (${response.status})`);
    },
    now: Date.now,
    pause: () => Bun.sleep(25),
  });
  let maintaining: Promise<void> | undefined;
  const ensure = () => {
    maintaining ??= pool.maintain().finally(() => {
      maintaining = undefined;
    });
    return maintaining;
  };
  const timer = setInterval(() => {
    void ensure().catch((error) =>
      console.error("Local compiler pool maintenance failed", { error }),
    );
  }, 60_000);
  timer.unref();
  return {
    snapshot: () => pool.snapshot(),
    projectEngine(projectId: string, store: ObjectStore): Engine {
      jobIdSchema.parse(projectId);
      return createPooledEngine({
        projectId,
        store,
        claim: (plan, claimId) => pool.claim(projectId, plan, claimId),
        release: (claimId) => pool.release(projectId, claimId),
        fetch: (name, request) => transport(name).fetch(request),
        discard: async (name) => {
          await transport(name).destroy();
          transports.delete(name);
        },
        prewarm: ensure,
      });
    },
    async close({ removeContainers = false } = {}) {
      clearInterval(timer);
      await maintaining;
      if (removeContainers) {
        const snapshot = pool.snapshot();
        for (const name of new Set([
          ...snapshot.spares.map((entry) => entry.name),
          ...snapshot.leases.map((entry) => entry.container),
        ]))
          await transport(name).destroy();
      }
      db.close();
    },
  };
}

// Historical cold-start measurements intentionally use an isolated project process.
export function localProjectEngine(
  projectId: string,
  options: DockerOptions & { store: ObjectStore },
): Engine {
  jobIdSchema.parse(projectId);
  const container = containerTransport(
    `texfolia-project-${projectId}`,
    options,
  );
  return createProjectEngineClient({
    projectId,
    store: options.store,
    fetch: container.fetch,
  });
}
