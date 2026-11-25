import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";

/**
 * Serves a browser entry that mounts the real workspace, with every server
 * function replaced by the fixture's and other requests sent to `backend`.
 */
export function createWorkspaceServer({
  entry,
  backend,
}: {
  entry: "editor-runtime" | "workspace-upload";
  backend: URL;
}) {
  const webRoot = fileURLToPath(new URL("../../", import.meta.url));
  const script = `test/${entry}/browser.tsx`;
  return createServer({
    configFile: false,
    root: webRoot,
    optimizeDeps: {
      entries: [script],
      include: ["react-pdf", "wasm-latex-tools"],
    },
    plugins: [
      tailwindcss(),
      {
        name: "workspace-fixture",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              `<!doctype html><html><body><div id="root"></div><script type="module" src="/${script}"></script></body></html>`,
            );
          });
        },
      },
    ],
    resolve: {
      alias: [
        {
          // Every server function the workspace calls; settings are browser code.
          find: /^#\/lib\/(?!settings\/).*\.functions$/,
          replacement: fileURLToPath(new URL("./rpc.ts", import.meta.url)),
        },
        { find: "#", replacement: `${webRoot}src` },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 0,
      forwardConsole: false,
      proxy: {
        "/fixture": backend.href,
        "/api": { target: backend.href, ws: true },
      },
    },
  });
}
