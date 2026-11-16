import { runWorkerIntegration } from "./worker-integration";

await runWorkerIntegration({
  name: "projects",
  entryPoint: new URL("./projects/worker.ts", import.meta.url),
});
