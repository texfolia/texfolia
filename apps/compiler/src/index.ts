import { createEngineClient } from "./engine";
import { createLocalRuntime } from "./local";
import { localProjectEngine } from "./local-containers";
import { maxSourceSyncBytes } from "./source-sync";

const runtime = createLocalRuntime({
  path: process.env.COMPILER_DB_PATH ?? ".cache/compiler.sqlite",
  engine: createEngineClient(
    (request) => fetch(request),
    process.env.ENGINE_URL ?? "http://127.0.0.1:8081",
  ),
  projectEngine: (projectId, store) =>
    localProjectEngine(projectId, {
      socket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
      image: process.env.ENGINE_IMAGE ?? "texfolia-latex-engine:local",
      network: process.env.COMPILER_DOCKER_NETWORK,
      store,
    }),
});

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8080),
  maxRequestBodySize: maxSourceSyncBytes,
  idleTimeout: 120,
  fetch: runtime.fetch,
});
console.log(`Compiler listening on ${server.url}`);
