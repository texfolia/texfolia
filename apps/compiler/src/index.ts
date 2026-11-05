import { compile } from "./compile";
import { createLocalRuntime } from "./local";
import { maxProjectBytes } from "./project";
import { createEngineHandler } from "./server";

const token = process.env.COMPILER_TOKEN;
const isEngine = process.env.COMPILER_MODE === "engine";
if ((isEngine || process.env.NODE_ENV === "production") && !token) {
  throw new Error("COMPILER_TOKEN is required in production or engine mode");
}
const version = Bun.spawnSync(["tectonic", "--version"]);
if (version.exitCode !== 0) throw new Error("Tectonic is unavailable");

const fetch = isEngine
  ? createEngineHandler({ token })
  : createLocalRuntime({
      path: process.env.COMPILER_DB_PATH ?? ".cache/compiler.sqlite",
      token,
      engine: compile,
    }).fetch;

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  maxRequestBodySize: maxProjectBytes,
  idleTimeout: 120,
  fetch,
});
console.log(`Compiler listening on ${server.url}`);
