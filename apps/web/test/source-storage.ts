import { runWorkerIntegration } from "./worker-integration";

await runWorkerIntegration({
  name: "source-storage",
  entryPoint: new URL("./source-storage/worker.ts", import.meta.url),
});
