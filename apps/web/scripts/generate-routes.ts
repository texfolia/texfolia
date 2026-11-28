import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const routeTreePath = new URL("../src/routeTree.gen.ts", import.meta.url);
const registerBlock = `
import type { getRouter } from './router.tsx'
import type { startInstance } from './start.ts'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
    config: Awaited<ReturnType<typeof startInstance.getOptions>>
  }
}
`;

const generated = spawnSync("bunx", ["tsr", "generate"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "inherit",
});
if (generated.status !== 0) process.exit(generated.status ?? 1);

let source = readFileSync(routeTreePath, "utf8");
if (!source.includes("declare module '@tanstack/react-start'")) {
  source = `${source.trimEnd()}\n${registerBlock}`;
  writeFileSync(routeTreePath, source);
}
