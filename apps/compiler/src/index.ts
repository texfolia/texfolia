import { createHandler } from "./server";

if (process.env.NODE_ENV === "production" && !process.env.COMPILER_TOKEN) {
  throw new Error("COMPILER_TOKEN is required in production");
}
// Fail startup rather than reporting readiness without an engine.
const version = Bun.spawnSync(["tectonic", "--version"]);
if (version.exitCode !== 0) throw new Error("Tectonic is unavailable");

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  maxRequestBodySize: 10 * 1024 * 1024,
  idleTimeout: 120,
  fetch: createHandler({ token: process.env.COMPILER_TOKEN }),
});
console.log(`Compiler listening on ${server.url}`);
