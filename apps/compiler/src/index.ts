import { assertLocalEnvironment } from "../../../scripts/local-environment.mts";
import { createLocalRuntime } from "./local";
import { createLocalContainerPool } from "./local-containers";
import { maxSourceSyncBytes } from "./source-sync";

assertLocalEnvironment(process.env);

const path = process.env.COMPILER_DB_PATH ?? ".cache/compiler.sqlite";
const pool = createLocalContainerPool({
  path: `${path}.pool.sqlite`,
  socket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  image: process.env.ENGINE_IMAGE ?? "texfolia-latex-engine:local",
  network: process.env.COMPILER_DOCKER_NETWORK,
});
const runtime = createLocalRuntime({
  path,
  projectEngine: pool.projectEngine,
});

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8080),
  maxRequestBodySize: maxSourceSyncBytes,
  idleTimeout: 120,
  fetch: runtime.fetch,
});
console.log(`Compiler listening on ${server.url}`);
