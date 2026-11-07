import { compile } from "./compile";
import { createLocalRuntime } from "./local";
import { maxProjectBytes } from "./project";
import { createEngineHandler } from "./server";

const isEngine = process.env.COMPILER_MODE === "engine";
const version = Bun.spawnSync(["tectonic", "--version"]);
if (version.exitCode !== 0) throw new Error("Tectonic is unavailable");

const fetch = isEngine
  ? createEngineHandler()
  : createLocalRuntime({
      path: process.env.COMPILER_DB_PATH ?? ".cache/compiler.sqlite",
      engine: compile,
    }).fetch;

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8080),
  maxRequestBodySize: maxProjectBytes,
  idleTimeout: 120,
  fetch,
});
console.log(`Compiler listening on ${server.url}`);
