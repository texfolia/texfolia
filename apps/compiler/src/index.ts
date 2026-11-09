import { createEngineClient } from "./engine";
import { createLocalRuntime } from "./local";
import { maxProjectBytes } from "./project";

const runtime = createLocalRuntime({
  path: process.env.COMPILER_DB_PATH ?? ".cache/compiler.sqlite",
  engine: createEngineClient(
    (request) => fetch(request),
    process.env.ENGINE_URL ?? "http://127.0.0.1:8081",
  ),
});

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8080),
  maxRequestBodySize: maxProjectBytes,
  idleTimeout: 120,
  fetch: runtime.fetch,
});
console.log(`Compiler listening on ${server.url}`);
