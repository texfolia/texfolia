import { runWorkerIntegration } from "./worker-integration";

await runWorkerIntegration({
  name: "templates",
  entryPoint: new URL("./templates/worker.ts", import.meta.url),
});
