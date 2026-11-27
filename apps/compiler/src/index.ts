import { assertLocalEnvironment } from "../../../scripts/local-environment.mts";
import { poolSettings } from "./config";
import { createLocalCompiler, sqliteStore } from "./local";
import { dockerContainers } from "./local-containers";

assertLocalEnvironment(process.env);

const compiler = createLocalCompiler({
  variables: process.env,
  store: sqliteStore(process.env.COMPILER_POOL_PATH ?? ".cache/pool.sqlite"),
  containers: dockerContainers({
    socket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    image: process.env.ENGINE_IMAGE ?? "texfolia-latex-engine:local",
    network: process.env.COMPILER_DOCKER_NETWORK,
    concurrency: poolSettings(process.env).concurrency,
  }),
});

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8080),
  maxRequestBodySize: 64 * 1024 * 1024,
  // A compile may run for minutes before its first byte.
  idleTimeout: 0,
  fetch: compiler.fetch,
});
console.log(`Compiler listening on ${server.url.href}`);
